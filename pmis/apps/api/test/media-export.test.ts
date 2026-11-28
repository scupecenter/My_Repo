import type { NestExpressApplication } from '@nestjs/platform-express';
import { unzipSync, strFromU8 } from 'fflate';
import { randomUUID } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageService } from '../src/documents/storage.service';
import { MediaExportService } from '../src/media/media-export.service';
import { loadSharp } from '../src/media/thumbs';
import { superDb, startApp } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, makeSite, plainAdmin } from './wf-helpers';

/**
 * Export of a selection from the Media gallery: POST /media/exports (zip with index.csv, audited, step-up protected, size cap from the
 * setting media.gallery.export_max_mb), GET /media/exports/{id} and /download. The job is a row of document_export_jobs (scope.kind = media_export).
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let docsQuality: Actor;
let docsOnly: Actor;
let otherRegion: Actor;
let nobody: Actor;
const ids: Record<string, string> = {};
let png = Buffer.alloc(0);
const key = (): string => `docs/2026/11/${randomUUID()}`;
const putImage = async (): Promise<string> => { const k = key(); await app.get(StorageService).store.putGenerated(k, png); return k; };
const settings = async (): Promise<Record<string, unknown>> => (await admin.api.call('get', '/media/settings')).body;
const setCap = async (mb: number): Promise<void> => {
  const cur = await admin.api.call('get', '/media/settings');
  const { updated_at, updated_by, version, can_edit, thumbnails_available, ...rest } = cur.body;
  void updated_at; void updated_by; void version; void can_edit; void thumbnails_available;
  const r = await admin.api.call('put', '/media/settings', { ...rest, export_max_mb: mb, reason: 'media export test' }, { 'If-Match': String(cur.headers.etag) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  const sharp = await loadSharp();
  if (!sharp) throw new Error('sharp is required for this suite');
  png = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 10, g: 120, b: 30 } } }).png().toBuffer();
  admin = await plainAdmin(app, db);
  docsQuality = await actor(app, db, { level: 'view', grants: [...G('sites', 'view'), ...G('quality', 'view'), ...G('sites.documents', 'view', 'download_documents')], regions: [5], modules: null });
  docsOnly = await actor(app, db, { level: 'view', grants: [...G('sites', 'view'), ...G('sites.documents', 'view', 'download_documents')], regions: [5], modules: null });
  otherRegion = await actor(app, db, { level: 'view', grants: [...G('sites', 'view'), ...G('quality', 'view'), ...G('sites.documents', 'view', 'download_documents')], regions: [6], modules: null });
  nobody = await actor(app, db, { level: 'view', grants: G('approvals', 'view'), regions: [5], modules: null });
  const site = await makeSite(db, 5);
  ids.site = site.id;
  ids.siteCode = (await db.query('SELECT site_code FROM sites WHERE id = $1', [site.id])).rows[0].site_code;
  const dt = await db.query(`INSERT INTO document_types (code, name_en, kind, updated_at) VALUES ($1, 'Export test photo', 'photo', now()) RETURNING id`, [`EXP_${randomUUID().slice(0, 6).toUpperCase()}`]);
  const slot = await db.query(`INSERT INTO document_slots (site_id, region_id, doc_type_id) VALUES ($1, 5, $2) RETURNING id`, [site.id, dt.rows[0].id]);
  ids.file = (await db.query(
    `INSERT INTO document_files (slot_id, file_group_id, original_name, stored_name, storage_key, mime_type, ext, size_bytes, sha256, uploaded_by, is_current)
     VALUES ($1, gen_random_uuid(), '=cmd.png', 'x.png', $2, 'image/png', 'png', $3, $4, $5, true) RETURNING id`,
    [slot.rows[0].id, await putImage(), png.length, 'a'.repeat(64), admin.user.id])).rows[0].id;
  const st = await db.query(`INSERT INTO snag_types (code, name_en) VALUES ($1, 'Export snag') RETURNING id`, [`ES${randomUUID().slice(0, 5).toUpperCase()}`]);
  const sg = await db.query(`INSERT INTO snags (site_id, region_id, snag_type_id, scope, description, raised_by) VALUES ($1, 5, $2, 'TE', 'crack', $3) RETURNING id`, [site.id, st.rows[0].id, admin.user.id]);
  ids.photo = (await db.query(
    `INSERT INTO snag_photos (snag_id, storage_key, mime_type, size_bytes, sha256, uploaded_by) VALUES ($1, $2, 'image/png', $3, $4, $5) RETURNING id`,
    [sg.rows[0].id, await putImage(), png.length, 'b'.repeat(64), admin.user.id])).rows[0].id;
});
afterAll(async () => {
  await setCap(500).catch(() => undefined);
  await db.end();
  await app.close();
});

const sel = (...x: [string, string][]) => ({ items: x.map(([kind, id]) => ({ kind, id })) });
const both = () => sel(['document_file', ids.file!], ['snag_photo', ids.photo!]);

describe('Media export', () => {
  it('zips the chosen images with an index.csv, audits start and download, and keeps the cap setting readable', async () => {
    expect((await settings()).export_max_mb).toBe(500);
    const s = await docsQuality.api.call('post', '/media/exports', both());
    expect(s.status, JSON.stringify(s.body)).toBe(202);
    await app.get(MediaExportService).idle();
    const j = await docsQuality.api.call('get', `/media/exports/${s.body.id}`);
    expect(j.body).toMatchObject({ kind: 'media_export', status: 'done', result: { file_count: 2 } });
    const d = await docsQuality.api.call('get', `/media/exports/${s.body.id}/download`).buffer(true).parse((res, cb) => {
      const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect(d.status).toBe(200);
    const files = unzipSync(new Uint8Array(d.body as Buffer));
    const names = Object.keys(files);
    expect(names).toContain('index.csv');
    expect(names.filter((n) => n !== 'index.csv').length).toBe(2);
    expect(names.some((n) => n.startsWith(`${ids.siteCode}/`))).toBe(true);
    const csv = strFromU8(files['index.csv']!);
    expect(csv).toContain('document_file');
    expect(csv).toContain('snag_photo');
    expect(csv).toContain(`"'=cmd.png"`);                                   // a spreadsheet must not run a file name
    const audit = await db.query(`SELECT action FROM audit_log WHERE entity_type = 'media_export' AND entity_id = $1 `, [s.body.id]);
    expect(audit.rows.map((r) => r.action).sort()).toEqual(['document_zip_download', 'document_zip_start']);
  });

  it('refuses what the caller may not see, and an export that is over the cap; the cap is a setting', async () => {
    expect((await docsOnly.api.call('post', '/media/exports', both())).status).toBe(422);        // no Quality module: the snag photo is not in their gallery
    expect((await otherRegion.api.call('post', '/media/exports', both())).status).toBe(422);
    expect((await nobody.api.call('post', '/media/exports', both())).status).toBe(403);
    expect((await docsQuality.api.call('post', '/media/exports', sel())).status).toBe(422);
    expect((await docsQuality.api.call('post', '/media/exports', sel(['snag_photo', randomUUID()]))).status).toBe(422);
    await setCap(10);
    expect((await settings()).export_max_mb).toBe(10);
    expect((await docsQuality.api.call('post', '/media/exports', both())).status).toBe(202);      // a few hundred bytes are under 10 MB
    // the recorded size is what the cap counts (a stored file never changes, so a second, larger file is added to the same slot and withdrawn after)
    const bigFile = (await db.query(
      `INSERT INTO document_files (slot_id, file_group_id, original_name, stored_name, storage_key, mime_type, ext, size_bytes, sha256, uploaded_by, is_current)
       SELECT slot_id, gen_random_uuid(), 'big.png', 'big.png', $2, 'image/png', 'png', $3, $4, $5, true FROM document_files WHERE id = $1 RETURNING id`,
      [ids.file, key(), 11 * 1024 * 1024, 'd'.repeat(64), admin.user.id])).rows[0].id as string;
    const big = await docsQuality.api.call('post', '/media/exports', sel(['document_file', bigFile]));
    expect(big.status).toBe(422);
    expect(JSON.stringify(big.body)).toContain('export_too_large');
    await db.query('UPDATE document_files SET is_current = false, withdrawn_at = now() WHERE id = $1', [bigFile]);
    await app.get(MediaExportService).idle();
  });

  it('shows a job only to the person who started it', async () => {
    const s = await docsQuality.api.call('post', '/media/exports', both());
    await app.get(MediaExportService).idle();
    expect((await admin.api.call('get', `/media/exports/${s.body.id}`)).status).toBe(404);
    expect((await admin.api.call('get', `/media/exports/${s.body.id}/download`)).status).toBe(404);
  });
});
