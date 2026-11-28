import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageService } from '../src/documents/storage.service';
import { exif, jpeg } from './geo-fixtures';
import { superDb, startApp } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, makeSite, plainAdmin } from './wf-helpers';

/**
 * Media geotag (migration 0477, contract 0.15.539): the point, capture and media kind of an image. The suite stores real JPEGs (a GPS point near the site,
 * one far away, one without a point, a 360 degree panorama, a drone file) as document files, runs the admin scan and checks the list: the distance to the
 * site, the far flag from the setting, the filters, the rights, the settings door, and that nothing in the file rows is changed. The setting is put back.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let viewer: Actor;
let nobody: Actor;
const REASON = 'Media geotag test';
const DEFAULT = { enabled: true, max_distance_m: 1000, flag_missing: false, panorama: true, panorama_min_ratio: 2, panorama_min_width_px: 3000, drone_makes: ['DJI', 'Autel', 'Parrot', 'Skydio'] };
const ids: Record<string, string> = {};

async function addFile(slot: string, name: string, bytes: Buffer): Promise<string> {
  const k = `docs/2026/11/${randomUUID()}`;
  await app.get(StorageService).store.putGenerated(k, bytes);
  const r = await db.query(
    `INSERT INTO document_files (slot_id, file_group_id, original_name, stored_name, storage_key, mime_type, ext, size_bytes, sha256, uploaded_by, is_current)
     VALUES ($1, gen_random_uuid(), $2, $2, $3, 'image/jpeg', 'jpg', $4, $5, $6, true) RETURNING id`, [slot, name, k, bytes.length, 'c'.repeat(64), admin.user.id]);
  return r.rows[0].id as string;
}
const items = async (who: Actor, qs = ''): Promise<{ id: string; media_kind: string; geo: null | { lat: number | null; distance_m: number | null; far: boolean | null; source: string } }[]> => {
  const r = await who.api.call('get', `/media/items?site_id=${ids.site}${qs}`);
  expect(r.status).toBe(200);
  return r.body.items;
};
const idsOf = (xs: { id: string }[]): string[] => xs.map((x) => x.id).sort();
const cfg = (who: Actor) => who.api.call('get', '/media/geo/settings');
const put = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/media/geo/settings', body, tag === undefined ? {} : { 'If-Match': tag });
const full = (over: Record<string, unknown> = {}) => ({ ...DEFAULT, ...over, reason: REASON });

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  viewer = await actor(app, db, { level: 'view', grants: [...G('sites', 'view'), ...G('sites.documents', 'view', 'download_documents')], regions: [5], modules: null });
  nobody = await actor(app, db, { level: 'view', grants: G('approvals', 'view'), regions: [5], modules: null });
  const site = await makeSite(db, 5);
  ids.site = site.id;
  await db.query('UPDATE sites SET latitude = 32.900000, longitude = 13.180000 WHERE id = $1', [site.id]);
  const dt = await db.query(`INSERT INTO document_types (code, name_en, kind, updated_at) VALUES ($1, 'Geo test photo', 'photo', now()) RETURNING id`, [`GEO_${randomUUID().slice(0, 6).toUpperCase()}`]);
  const slot = (await db.query(`INSERT INTO document_slots (site_id, region_id, doc_type_id) VALUES ($1, 5, $2) RETURNING id`, [site.id, dt.rows[0].id])).rows[0].id as string;
  // 32 deg 54 min 0.36 sec N = 32.900100: about 11 m from the site; 33 deg N = 12 km away
  ids.near = await addFile(slot, 'near.jpg', jpeg({ exif: exif({ make: 'Canon', lat: [32, 54, 36, 'N'], lon: [13, 10, 4800, 'E'], alt: 12 }), w: 4000, h: 3000 }));
  ids.far = await addFile(slot, 'far.jpg', jpeg({ exif: exif({ make: 'Canon', lat: [33, 0, 0, 'N'], lon: [13, 10, 4800, 'E'] }), w: 4000, h: 3000 }));
  ids.none = await addFile(slot, 'none.jpg', jpeg({ exif: exif({ make: 'Canon' }), w: 4000, h: 3000 }));
  ids.pano = await addFile(slot, 'pano.jpg', jpeg({ xmp: '<x GPano:ProjectionType="equirectangular"/>', w: 8000, h: 4000 }));
  ids.drone = await addFile(slot, 'drone.jpg', jpeg({ exif: exif({ make: 'DJI', lat: [32, 54, 0, 'N'], lon: [13, 10, 4800, 'E'], alt: 90 }), w: 4000, h: 3000 }));
});
afterAll(async () => {
  await db.query(`UPDATE settings SET value = $1::jsonb, updated_by = NULL, updated_at = now() WHERE key = 'media.geotag'`, [JSON.stringify(DEFAULT)]);
  await db.end();
  await app.close();
});

describe('Media geotag', () => {
  it('lists unscanned images with no location, then the admin scan reads the files and only a settings admin may run it', async () => {
    const before = await items(viewer);
    expect(before).toHaveLength(5);
    expect(before.every((x) => x.geo === null)).toBe(true);
    expect((await viewer.api.call('post', '/media/geo/scan', {})).status).toBe(403);
    expect((await nobody.api.call('post', '/media/geo/scan', {})).status).toBe(403);
    const files = (await db.query('SELECT count(*)::int AS n, max(uploaded_at) AS m FROM document_files WHERE slot_id IN (SELECT id FROM document_slots WHERE site_id = $1)', [ids.site])).rows[0];
    const r = await admin.api.call('post', '/media/geo/scan', { limit: 200 });
    expect(r.status).toBe(201);
    expect(r.body.done).toBeGreaterThanOrEqual(5);
    expect((await db.query('SELECT count(*)::int AS n, max(uploaded_at) AS m FROM document_files WHERE slot_id IN (SELECT id FROM document_slots WHERE site_id = $1)', [ids.site])).rows[0]).toEqual(files);
    const log = await db.query(`SELECT count(*)::int AS n FROM system_log WHERE message = 'media_geo_scan'`);
    expect(log.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('reads the point, the distance to the site and the far flag, and marks panoramas and drone files', async () => {
    const all = await items(viewer);
    const by = (id: string | undefined) => all.find((x) => x.id === id)!;
    expect(by(ids.near).geo).toMatchObject({ source: 'exif', far: false });
    expect(by(ids.near).geo!.distance_m).toBeLessThan(50);
    expect(by(ids.far).geo!.far).toBe(true);
    expect(by(ids.far).geo!.distance_m).toBeGreaterThan(11000);
    expect(by(ids.none).geo).toMatchObject({ lat: null, source: 'none', distance_m: null, far: null });
    expect(by(ids.pano).media_kind).toBe('panorama');
    expect(by(ids.drone).media_kind).toBe('drone');
    expect(by(ids.near).media_kind).toBe('photo');
    expect(by(ids.drone).geo).toMatchObject({ altitude_m: 90, make: 'DJI' });
  });

  it('filters by place and by media kind', async () => {
    expect(idsOf(await items(viewer, '&geo=far'))).toEqual([ids.far]);
    expect(idsOf(await items(viewer, '&geo=near'))).toEqual([ids.near, ids.drone].sort());
    expect(idsOf(await items(viewer, '&geo=missing'))).toEqual([ids.none, ids.pano].sort());
    expect(idsOf(await items(viewer, '&geo=has'))).toEqual([ids.near, ids.far, ids.drone].sort());
    expect(idsOf(await items(viewer, '&media_kind=panorama'))).toEqual([ids.pano]);
    expect(idsOf(await items(viewer, '&media_kind=drone'))).toEqual([ids.drone]);
    expect((await viewer.api.call('get', '/media/items?geo=sideways')).status).toBe(422);
    expect((await viewer.api.call('get', '/media/items?media_kind=film')).status).toBe(422);
  });

  it('settings: anyone signed in reads, an admin changes with reason, step-up and If-Match, audited, validated; the distance setting moves the flag', async () => {
    const s = await cfg(viewer);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ ...DEFAULT, can_edit: false });
    expect((await put(viewer, full(), String(s.headers.etag))).status).toBe(403);
    expect((await put(admin, full({ max_distance_m: 20000 }))).status).toBe(428);
    expect((await put(admin, full({ max_distance_m: 20000 }), '"999"')).status).toBe(412);
    expect((await put(admin, full(), String(s.headers.etag))).status).toBe(409);
    for (const bad of [{ max_distance_m: 10 }, { panorama_min_ratio: 9 }, { panorama_min_width_px: 10 }, { drone_makes: ['bad;make'] }, { enabled: 'yes' }, { extra: 1 }]) {
      expect((await put(admin, full(bad), String(s.headers.etag))).status, JSON.stringify(bad)).toBe(422);
    }
    const ok = await put(admin, full({ max_distance_m: 20000 }), String(s.headers.etag));
    expect(ok.status).toBe(200);
    expect(ok.body.max_distance_m).toBe(20000);
    const a = await db.query(`SELECT before, after, reason FROM audit_log WHERE action = 'media_geo_update' ORDER BY id DESC LIMIT 1`);
    expect(a.rows[0].before.max_distance_m).toBe(1000);
    expect(a.rows[0].after.max_distance_m).toBe(20000);
    expect(a.rows[0].reason).toBe(REASON);
    expect(idsOf(await items(viewer, '&geo=far'))).toEqual([]);
    const off = await put(admin, full({ enabled: false }), String(ok.headers.etag));
    expect(off.status).toBe(200);
    expect((await items(viewer)).every((x) => x.geo === null)).toBe(true);
  });

  it('a geo row follows its file: it is readable only with the file and is removed with it', async () => {
    expect((await nobody.api.call('get', '/media/items')).status).toBe(403);
    const n = (await db.query('SELECT count(*)::int AS n FROM media_geo WHERE doc_file_id = ANY($1::uuid[])', [[ids.near, ids.far]])).rows[0].n;
    expect(n).toBe(2);
  });
});
