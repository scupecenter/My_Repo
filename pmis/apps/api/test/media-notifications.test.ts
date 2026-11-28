import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superDb, startApp } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, makeSite, plainAdmin } from './wf-helpers';

/**
 * Notices of the Media gallery (migration 0472): a new photo on a followed site (watches, kind followed_change), photo slots below their
 * minimum (media_notify_tick, kind system, once per site inside the repeat window) and a finished media export (document_export_jobs).
 * All of it is switched in the setting media.gallery (notify_new_photo, notify_min_photos, notify_export_ready, min_photos_after_hours, min_photos_repeat_days).
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let follower: Actor;
const ids: Record<string, string> = {};

const setNotify = async (patch: Record<string, unknown>): Promise<void> => {
  const cur = await admin.api.call('get', '/media/settings');
  const { updated_at, updated_by, version, can_edit, thumbnails_available, ...rest } = cur.body;
  void updated_at; void updated_by; void version; void can_edit; void thumbnails_available;
  const r = await admin.api.call('put', '/media/settings', { ...rest, ...patch, reason: 'media notices test' }, { 'If-Match': String(cur.headers.etag) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const addFile = async (slot: string, uploader: string): Promise<void> => {
  await db.query(
    `INSERT INTO document_files (slot_id, file_group_id, original_name, stored_name, storage_key, mime_type, ext, size_bytes, sha256, uploaded_by, is_current)
     VALUES ($1, gen_random_uuid(), 'p.png', 'p.png', $2, 'image/png', 'png', 10, $3, $4, true)`, [slot, `docs/2026/11/${randomUUID()}`, 'c'.repeat(64), uploader]);
};
const notices = async (user: string, kind: string): Promise<{ title: string; link: string | null }[]> =>
  (await db.query(`SELECT title, link FROM notifications WHERE user_id = $1 AND kind = $2 ORDER BY created_at`, [user, kind])).rows;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  follower = await actor(app, db, { level: 'view', grants: [...G('sites', 'view'), ...G('sites.documents', 'view')], regions: [5], modules: null });
  const site = await makeSite(db, 5);
  ids.site = site.id;
  ids.code = (await db.query('SELECT site_code FROM sites WHERE id = $1', [site.id])).rows[0].site_code;
  const dt = await db.query(`INSERT INTO document_types (code, name_en, kind, min_files, updated_at) VALUES ($1, 'Notice test photo', 'photo', 2, now()) RETURNING id`, [`NT_${randomUUID().slice(0, 6).toUpperCase()}`]);
  ids.slot = (await db.query(`INSERT INTO document_slots (site_id, region_id, doc_type_id, created_at) VALUES ($1, 5, $2, now() - interval '3 days') RETURNING id`, [site.id, dt.rows[0].id])).rows[0].id;
  expect((await follower.api.call('put', `/sites/${site.id}/follow`)).status).toBe(200);
});
afterAll(async () => {
  await setNotify({ notify_new_photo: true, notify_min_photos: true, notify_export_ready: true, min_photos_after_hours: 24, min_photos_repeat_days: 7 }).catch(() => undefined);
  await db.end();
  await app.close();
});

describe('media notices', () => {
  it('settings: defaults on, bounds checked, a write that leaves the keys out keeps them', async () => {
    const s = (await admin.api.call('get', '/media/settings')).body;
    expect([s.notify_new_photo, s.notify_min_photos, s.notify_export_ready, s.min_photos_after_hours, s.min_photos_repeat_days]).toEqual([true, true, true, 24, 7]);
    const { updated_at, updated_by, version, can_edit, thumbnails_available, notify_new_photo, notify_min_photos, notify_export_ready, min_photos_after_hours, min_photos_repeat_days, ...rest } = s;
    void [updated_at, updated_by, version, can_edit, thumbnails_available, notify_new_photo, notify_min_photos, notify_export_ready, min_photos_after_hours, min_photos_repeat_days];
    const cur = await admin.api.call('get', '/media/settings');
    const bad = await admin.api.call('put', '/media/settings', { ...rest, min_photos_after_hours: 0, reason: 'bad' }, { 'If-Match': String(cur.headers.etag) });
    expect(bad.status).toBe(422);
    await setNotify({ notify_min_photos: false });
    const cur2 = await admin.api.call('get', '/media/settings');
    const keep = await admin.api.call('put', '/media/settings', { ...rest, reason: 'older client' }, { 'If-Match': String(cur2.headers.etag) });
    expect(keep.status).toBe(200);
    expect(keep.body.notify_min_photos).toBe(false);
    await setNotify({ notify_min_photos: true });
  });

  it('a new photo tells the followers of the site, not the person who uploaded, and obeys the switch', async () => {
    await addFile(ids.slot!, admin.user.id);
    const got = await notices(follower.user.id, 'followed_change');
    expect(got.some((n) => n.title === 'New photo on a followed site' && n.link === `/library/media?q=${ids.code}`)).toBe(true);
    expect((await notices(admin.user.id, 'followed_change')).some((n) => n.title === 'New photo on a followed site')).toBe(false);
    const before = got.length;
    await setNotify({ notify_new_photo: false });
    await addFile(ids.slot!, admin.user.id);
    expect((await notices(follower.user.id, 'followed_change')).length).toBe(before);
    await setNotify({ notify_new_photo: true });
  });

  it('photo slots below the minimum: one notice per site and person inside the repeat window', async () => {
    await db.query(`DELETE FROM notifications WHERE kind = 'system' AND title = $1`, [`Photos below the minimum at ${ids.code}`]);
    await db.query(`UPDATE document_files SET withdrawn_at = now() WHERE slot_id = $1`, [ids.slot]);
    const first = (await db.query('SELECT media_notify_tick() AS n')).rows[0].n as number;
    const rows = (await db.query(`SELECT user_id, link FROM notifications WHERE kind = 'system' AND title = $1`, [`Photos below the minimum at ${ids.code}`])).rows;
    expect(first).toBeGreaterThanOrEqual(rows.length);
    for (const r of rows) expect(r.link).toBe(`/library/media?q=${ids.code}`);
    const again = (await db.query('SELECT media_notify_tick() AS n')).rows[0].n as number;
    const rows2 = (await db.query(`SELECT 1 FROM notifications WHERE kind = 'system' AND title = $1`, [`Photos below the minimum at ${ids.code}`])).rows;
    expect(rows2.length).toBe(rows.length);
    expect(again).toBeGreaterThanOrEqual(0);
    await setNotify({ notify_min_photos: false });
    await db.query(`DELETE FROM notifications WHERE kind = 'system' AND title = $1`, [`Photos below the minimum at ${ids.code}`]);
    expect((await db.query('SELECT media_notify_tick() AS n')).rows[0].n).toBe(0);
    await setNotify({ notify_min_photos: true });
  });

  it('a finished media export tells the person who asked, once, and only for a media export', async () => {
    const job = (scope: object) => db.query(`INSERT INTO document_export_jobs (requested_by, scope) VALUES ($1, $2::jsonb) RETURNING id`, [admin.user.id, JSON.stringify(scope)]);
    const media = (await job({ kind: 'media_export', items: [] })).rows[0].id as string;
    const other = (await job({ kind: 'documents' })).rows[0].id as string;
    for (const id of [media, other]) await db.query(`UPDATE document_export_jobs SET status = 'done', file_count = 3, finished_at = now() WHERE id = $1`, [id]);
    await db.query(`UPDATE document_export_jobs SET file_count = 4 WHERE id = $1`, [media]);
    const got = (await notices(admin.user.id, 'system')).filter((n) => n.title === 'Your photo export is ready');
    expect(got.filter((n) => n.link === `/library/media?export=${media}`).length).toBe(1);
    expect(got.some((n) => n.link === `/library/media?export=${other}`)).toBe(false);
  });
});
