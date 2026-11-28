import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/auth/rate-limiter';
import { StorageService } from '../src/documents/storage.service';
import { applyLimits, resetLimits } from '../src/ops/ops-limits';
import { loadSharp, makeThumb } from '../src/media/thumbs';
import { superDb, startApp } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, makeSite, plainAdmin } from './wf-helpers';

/**
 * The central Media gallery (owner decisions GAL-1 and LIB-1, 2026-11-27, migration 0396, contract 0.15.292): GET /media/items, /media/facets,
 * /media/items/{kind}/{id}/thumbnail and GET / PUT /media/settings (setting media.gallery). The suite writes rows straight into document_files and
 * snag_photos (the owning tables) with real stored images, then checks that the gallery shows exactly what the owning slot allows, that nothing is
 * copied, that a withdrawn item is hidden (never deleted) and that every setting changes what is listed. The setting is put back at the end.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let docsOnly: Actor;      // Documents view in region 5, no Quality module
let docsQuality: Actor;   // Documents view and Quality view in region 5
let otherRegion: Actor;   // the same rights in region 6
let nobody: Actor;        // no Documents grant
const REASON = 'Owner decision GAL-1 2026-11-27';
const DEFAULT = {
  enabled: true, snag_photos: true, document_kinds: ['photo', 'scanned_document'], register_keys: [], include_site_documents: true, exclude_doc_codes: [], image_only: true,
  show_withdrawn: false, page_size: 48, export_max_mb: 500, thumbnails: { enabled: true, small_px: 240, medium_px: 640, quality: 78, format: 'webp', max_source_mb: 50 },
};
const ids: Record<string, string> = {};
let png = Buffer.alloc(0);

const key = (): string => `docs/2026/11/${randomUUID()}`;
async function putImage(): Promise<string> {
  const k = key();
  await app.get(StorageService).store.putGenerated(k, png);
  return k;
}

async function addFile(slot: string, name: string, over: { mime?: string; current?: boolean; withdrawn?: boolean } = {}): Promise<string> {
  const k = await putImage();
  const r = await db.query(
    `INSERT INTO document_files (slot_id, file_group_id, original_name, stored_name, storage_key, mime_type, ext, size_bytes, sha256, uploaded_by, is_current, withdrawn_at)
     VALUES ($1, gen_random_uuid(), $2, $2, $3, $4, 'png', $5, $6, $7, $8, $9) RETURNING id`,
    [slot, name, k, over.mime ?? 'image/png', png.length, 'a'.repeat(64), admin.user.id, over.current ?? true, over.withdrawn ? new Date() : null],
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  const sharp = await loadSharp();
  if (!sharp) throw new Error('sharp is required for this suite');
  png = await sharp({ create: { width: 800, height: 400, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
  admin = await plainAdmin(app, db);
  docsOnly = await actor(app, db, { level: 'view', grants: [...G('sites', 'view'), ...G('sites.documents', 'view', 'download_documents')], regions: [5], modules: null });
  docsQuality = await actor(app, db, { level: 'view', grants: [...G('sites', 'view'), ...G('quality', 'view'), ...G('sites.documents', 'view', 'download_documents')], regions: [5], modules: null });
  otherRegion = await actor(app, db, { level: 'view', grants: [...G('sites', 'view'), ...G('quality', 'view'), ...G('sites.documents', 'view', 'download_documents')], regions: [6], modules: null });
  nobody = await actor(app, db, { level: 'view', grants: G('approvals', 'view'), regions: [5], modules: null });

  const site = await makeSite(db, 5);
  ids.site = site.id;
  const dt = await db.query(`INSERT INTO document_types (code, name_en, kind, updated_at) VALUES ($1, 'Gallery test photo', 'photo', now()) RETURNING id`, [`GAL_${randomUUID().slice(0, 6).toUpperCase()}`]);
  ids.type = dt.rows[0].id;
  ids.code = (await db.query('SELECT code FROM document_types WHERE id = $1', [ids.type])).rows[0].code;
  const pdfType = await db.query(`INSERT INTO document_types (code, name_en, kind, updated_at) VALUES ($1, 'Gallery test scan', 'scanned_document', now()) RETURNING id`, [`GALS_${randomUUID().slice(0, 6).toUpperCase()}`]);
  const slot = await db.query(`INSERT INTO document_slots (site_id, region_id, doc_type_id) VALUES ($1, 5, $2) RETURNING id`, [site.id, ids.type]);
  const pdfSlot = await db.query(`INSERT INTO document_slots (site_id, region_id, doc_type_id) VALUES ($1, 5, $2) RETURNING id`, [site.id, pdfType.rows[0].id]);
  ids.current = await addFile(slot.rows[0].id, 'current.png');
  ids.old = await addFile(slot.rows[0].id, 'old.png', { current: false });
  ids.withdrawn = await addFile(slot.rows[0].id, 'withdrawn.png', { current: false, withdrawn: true });
  ids.pdf = await addFile(pdfSlot.rows[0].id, 'scan.pdf', { mime: 'application/pdf' });
  const st = await db.query(`INSERT INTO snag_types (code, name_en) VALUES ($1, 'Gallery snag') RETURNING id`, [`GS${randomUUID().slice(0, 5).toUpperCase()}`]);
  const sg = await db.query(`INSERT INTO snags (site_id, region_id, snag_type_id, scope, description, raised_by) VALUES ($1, 5, $2, 'TE', 'crack', $3) RETURNING id`, [site.id, st.rows[0].id, admin.user.id]);
  ids.snag = sg.rows[0].id;
  const ph = async (over = ''): Promise<string> => (await db.query(
    `INSERT INTO snag_photos (snag_id, storage_key, mime_type, size_bytes, sha256, uploaded_by ${over ? ', ' + over.split('=')[0] : ''}) VALUES ($1, $2, 'image/png', $3, $4, $5 ${over ? ', ' + over.split('=')[1] : ''}) RETURNING id`,
    [sg.rows[0].id, await putImage(), png.length, 'b'.repeat(64), admin.user.id])).rows[0].id as string;
  ids.photo = await ph();
  ids.photoGone = await ph('withdrawn_at=now()');
});
afterAll(async () => {
  await db.query(`UPDATE settings SET value = $1::jsonb, updated_by = NULL, updated_at = now() WHERE key = 'media.gallery'`, [JSON.stringify(DEFAULT)]);
  await db.end();
  await app.close();
});

const items = async (who: Actor, qs = ''): Promise<{ kind: string; id: string; state: string }[]> => {
  const r = await who.api.call('get', `/media/items?site_id=${ids.site}${qs}`);
  expect(r.status).toBe(200);
  return r.body.items;
};
const idsOf = (xs: { id: string }[]): string[] => xs.map((x) => x.id).sort();
const settings = (who: Actor) => who.api.call('get', '/media/settings');
const put = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/media/settings', body, tag === undefined ? {} : { 'If-Match': tag });
const full = (over: Record<string, unknown> = {}) => ({ ...DEFAULT, ...over, reason: REASON });

describe('Media gallery', () => {
  it('lists the current images of both sources, hides superseded, withdrawn and non-image files, copies nothing', async () => {
    const r = await items(docsQuality);
    expect(idsOf(r)).toEqual([ids.current, ids.photo].sort());
    const before = (await db.query('SELECT (SELECT count(*) FROM document_files) a, (SELECT count(*) FROM snag_photos) b')).rows[0];
    await items(docsQuality);
    expect((await db.query('SELECT (SELECT count(*) FROM document_files) a, (SELECT count(*) FROM snag_photos) b')).rows[0]).toEqual(before);
    const one = (await docsQuality.api.call('get', `/media/items?site_id=${ids.site}&source=snags`)).body.items[0];
    expect(one).toMatchObject({ kind: 'snag_photo', link: { kind: 'snag', snag_id: ids.snag }, has_thumbnail: true, state: 'current' });
  });

  it('follows the rights of the owning slot: Quality module for snag photos, region, Documents grant', async () => {
    expect(idsOf(await items(docsOnly))).toEqual([ids.current]);
    expect(await items(otherRegion)).toEqual([]);
    expect((await nobody.api.call('get', '/media/items')).status).toBe(403);
    // a thumbnail of an item the caller may not see is a 404, like the item itself
    expect((await docsOnly.api.call('get', `/media/items/snag_photo/${ids.photo}/thumbnail`)).status).toBe(404);
    expect((await otherRegion.api.call('get', `/media/items/document_file/${ids.current}/thumbnail`)).status).toBe(404);
    expect((await nobody.api.call('get', `/media/items/document_file/${ids.current}/thumbnail`)).status).toBe(403);
  });

  it('makes a thumbnail on the first request, keeps it beside the original and serves the same bytes again', async () => {
    const a = await docsQuality.api.call('get', `/media/items/document_file/${ids.current}/thumbnail?size=small`).buffer(true).parse((res, cb) => {
      const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect(a.status).toBe(200);
    expect(a.headers['content-type']).toContain('image/webp');
    const meta = await (await loadSharp())!(a.body as Buffer).metadata();
    expect(meta.width).toBe(240);                       // 800x400 fits in 240: 240x120
    expect(meta.height).toBe(120);
    const b = await docsQuality.api.call('get', `/media/items/document_file/${ids.current}/thumbnail?size=small`).buffer(true).parse((res, cb) => {
      const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect((b.body as Buffer).equals(a.body as Buffer)).toBe(true);
    expect((await docsQuality.api.call('get', `/media/items/document_file/${ids.current}/thumbnail?size=huge`)).status).toBe(422);
    expect((await docsQuality.api.call('get', `/media/items/document_file/${ids.pdf}/thumbnail`)).status).toBe(404);   // not in the images-only scope
  });
  it('SEC-2: making thumbnails is limited per person per minute (ops.limits); a thumbnail already made and a limit of 0 are never refused', async () => {
    (app.get(RateLimiter) as unknown as { hits: Map<string, number[]> }).hits.clear();
    try {
      applyLimits({ 'media.thumbnails_per_minute': 1 }, ['media.thumbnails_per_minute']);
      const medium = await docsQuality.api.call('get', `/media/items/document_file/${ids.current}/thumbnail?size=medium`);
      expect(medium.status, JSON.stringify(medium.body)).toBe(200);                      // the first one made
      const cached = await docsQuality.api.call('get', `/media/items/document_file/${ids.current}/thumbnail?size=small`);
      expect(cached.status).toBe(200);                                                     // already made: free
      const refused = await docsQuality.api.call('get', `/media/items/snag_photo/${ids.photo}/thumbnail?size=small`);
      expect(refused.status).toBe(429);                                                    // a second one to make in the same minute
      expect(refused.body).toMatchObject({ code: 'rate_limited' });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      const logged = await db.query(`SELECT 1 FROM system_log WHERE message = 'thumbnail_rate_limited' LIMIT 1`);
      expect(logged.rowCount).toBeGreaterThan(0);
      applyLimits({ 'media.thumbnails_per_minute': 0 }, ['media.thumbnails_per_minute']);   // 0 = no limit
      const free = await docsQuality.api.call('get', `/media/items/snag_photo/${ids.photo}/thumbnail?size=small`);
      expect(free.status).toBe(200);
    } finally {
      resetLimits();
    }
  });

  it('makes no thumbnail of a tiny source (the card shows the type icon), a normal one still works', async () => {
    const sharp = (await loadSharp())!;
    const tiny = await sharp({ create: { width: 8, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    await expect(makeThumb(tiny, 240, 'webp', 78)).rejects.toThrow('source_too_small');
    expect(await makeThumb(png, 240, 'webp', 78)).toMatchObject({ width: 240, height: 120 });
  });

  it('hides a withdrawal at once and never deletes the row', async () => {
    await db.query(`UPDATE document_files SET withdrawn_at = now(), is_current = false WHERE id = $1`, [ids.current]);
    expect(idsOf(await items(docsQuality))).toEqual([ids.photo]);
    expect((await db.query('SELECT 1 FROM document_files WHERE id = $1', [ids.current])).rowCount).toBe(1);
    await db.query(`UPDATE document_files SET withdrawn_at = NULL, is_current = true WHERE id = $1`, [ids.current]);
    expect(idsOf(await items(docsQuality))).toEqual([ids.current, ids.photo].sort());
  });

  it('filters by source, type, date and text', async () => {
    expect(idsOf(await items(docsQuality, `&doc_code=${ids.code}`))).toEqual([ids.current]);
    expect(idsOf(await items(docsQuality, '&source=snags'))).toEqual([ids.photo]);
    expect(await items(docsQuality, '&uploaded_to=2000-01-01')).toEqual([]);
    expect(idsOf(await items(docsQuality, '&q=current.png'))).toEqual([ids.current]);
    const f = (await docsQuality.api.call('get', '/media/facets')).body;
    expect(f.document_types.map((t: { code: string }) => t.code)).toContain(ids.code);
    expect((await docsQuality.api.call('get', '/media/items?status=bogus')).status).toBe(422);
    expect((await docsQuality.api.call('get', '/media/items?status=withdrawn')).status).toBe(422);       // listing is off by default
  });

  it('settings: any signed-in user reads, an admin changes with reason, step-up and If-Match, audited, validated', async () => {
    const s = await settings(docsOnly);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ ...DEFAULT, can_edit: false, thumbnails_available: true });
    expect((await put(docsOnly, full(), String(s.headers.etag))).status).toBe(403);
    expect((await put(admin, full({ page_size: 24 }))).status).toBe(428);
    expect((await put(admin, full({ page_size: 24 }), '"999"')).status).toBe(412);
    expect((await put(admin, full(), String(s.headers.etag))).status).toBe(409);                           // the values in force
    for (const bad of [{ page_size: 5 }, { document_kinds: ['video'] }, { register_keys: ['no_such_register'] }, { exclude_doc_codes: ['bad code'] }, { thumbnails: { ...DEFAULT.thumbnails, small_px: 700 } }, { thumbnails: { ...DEFAULT.thumbnails, format: 'png' } }, { extra: 1 }]) {
      expect((await put(admin, full(bad), String(s.headers.etag))).status, JSON.stringify(bad)).toBe(422);
    }
    const ok = await put(admin, full({ page_size: 24, show_withdrawn: true }), String(s.headers.etag));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ page_size: 24, show_withdrawn: true, can_edit: true });
    const a = await db.query(`SELECT before, after, reason FROM audit_log WHERE action = 'media_gallery_update' ORDER BY id DESC LIMIT 1`);
    expect(a.rows[0].before.page_size).toBe(48);
    expect(a.rows[0].after.page_size).toBe(24);
    expect(a.rows[0].reason).toBe(REASON);
    // with listing allowed, the withdrawn file shows when asked for
    expect(idsOf(await items(docsQuality, '&status=withdrawn'))).toEqual([ids.photoGone, ids.withdrawn].sort());
  });

  it('settings change what is listed: sources, kinds, excluded codes, images only, thumbnails', async () => {
    const tag = async (): Promise<string> => String((await settings(admin)).headers.etag);
    const set = async (over: Record<string, unknown>) => expect((await put(admin, full({ page_size: 24, show_withdrawn: true, ...over }), await tag())).status).toBe(200);
    await set({ snag_photos: false });
    expect(idsOf(await items(docsQuality))).toEqual([ids.current]);
    await set({ snag_photos: true, exclude_doc_codes: [ids.code] });
    expect(idsOf(await items(docsQuality))).toEqual([ids.photo]);
    await set({ exclude_doc_codes: [], image_only: false });
    expect(idsOf(await items(docsQuality))).toEqual([ids.current, ids.pdf, ids.photo].sort());
    await set({ image_only: true, document_kinds: [] });
    expect(idsOf(await items(docsQuality))).toEqual([ids.photo]);
    await set({ document_kinds: ['photo', 'scanned_document'], include_site_documents: false });
    expect(idsOf(await items(docsQuality))).toEqual([ids.photo]);                                     // no register slot: only the snag photo
    await set({ include_site_documents: true, thumbnails: { ...DEFAULT.thumbnails, enabled: false } });
    expect((await docsQuality.api.call('get', `/media/items/document_file/${ids.current}/thumbnail`)).status).toBe(503);
    expect((await items(docsQuality))[0]).toMatchObject({ has_thumbnail: false });
    await set({ enabled: false });
    expect((await docsQuality.api.call('get', '/media/items')).body).toMatchObject({ enabled: false, items: [] });
  });
  it('keeps saved views of the Media tab (screen library-media) for who may see Documents only', async () => {
    const ok = await docsQuality.api.call('post', '/saved-views', { screen_key: 'library-media', name: `Media ${randomUUID().slice(0, 6)}`, filters: { source: 'snags' } });
    expect([200, 201], JSON.stringify(ok.body)).toContain(ok.status);
    expect((await docsQuality.api.call('get', '/saved-views?screen_key=library-media')).status).toBe(200);
    expect((await nobody.api.call('post', '/saved-views', { screen_key: 'library-media', name: `Media ${randomUUID().slice(0, 6)}`, filters: {} })).status).toBe(403);
  });
});
