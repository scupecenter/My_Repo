import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, startApp, superDb } from './helpers';
import { G, regCell } from './reg-helpers';
import { type Actor, actor, makeSite } from './wf-helpers';

/**
 * Item 14 of the 2026-11-27 batch: a short field video uploads through the snag photo path when the
 * snag type lists the format (sniff learns webm / mp4 / mov; a video is never an image and carries no EXIF, so it lands with the
 * unknown-capture-date flag, per Q132). The formats list still gates: a video of a type that does not list it is refused.
 * Region 6 on the shared database; the suite makes its own snag types and sites, so parallel files cannot break it.
 */
let app: NestExpressApplication;
let db: PgClient;
let adminApiCall: Awaited<ReturnType<typeof adminApi>>['api'];
const R = 6;
const U = randomBytes(3).toString('hex').toUpperCase();
const DL: [string, string] = ['sites.documents', 'download_documents'];

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(120, 7)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(120, 7)]);

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  adminApiCall = (await adminApi(app, db)).api;
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const videoType = async (formats: string[]): Promise<string> => {
  const t = await adminApiCall.call('post', '/snag-types', {
    code: `TV${randomBytes(2).toString('hex').toUpperCase()}`, name_en: 'Video snag', photo_rules: { min_count: 1, formats, max_size_mb: 20 }, reason: 'test setup',
  });
  expect(t.status).toBe(201);
  return t.body.id as string;
};
const team = async () => {
  const e = await actor(app, db, { level: 'entry', regions: [R], grants: [...G('quality', 'view', 'create', 'edit'), ['sites', 'view'], ['sites', 'edit'], DL] });
  await regCell(db, 'quality', R, 'entry', { user: [e.user.id] });
  return { e, site: await makeSite(db, R, { prefix: `V${U}` }) };
};
const raise = async (e: Actor, siteId: string, type: string) => {
  const r = await e.api.call('post', `/sites/${siteId}/snags`, { snag_type_id: type, scope: 'CW', title: 'Ponding at gate', severity: 'MINOR' });
  expect(r.status).toBe(201);
  return r.body.id as string;
};
const upload = (e: Actor, id: string, buf: Buffer, name: string, contentType: string) =>
  e.api.call('post', `/snags/${id}/photos`).attach('file', buf, { filename: name, contentType });

describe('snag quick capture: a short video is a photo when the type allows it', () => {
  it('accepts webm with the unknown-capture-date flag (no EXIF), refuses a format the type does not list', async () => {
    const type = await videoType(['JPG', 'WEBM']);
    const { e, site } = await team();
    const id = await raise(e, site.id, type);

    const ok = await upload(e, id, WEBM, 'gate.webm', 'video/webm');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ unknown_capture_date: true, status: 'accepted' });

    const mp4 = await upload(e, id, MP4, 'gate.mp4', 'video/mp4');
    expect(mp4.status).toBe(422);
    expect(mp4.body).toMatchObject({ code: 'file_rejected', reason: 'format_not_allowed' });
  });

  it('refuses a video for a type that lists images only, exactly like any other unlisted format', async () => {
    const type = await videoType(['JPG']);
    const { e, site } = await team();
    const id = await raise(e, site.id, type);
    const res = await upload(e, id, WEBM, 'gate.webm', 'video/webm');
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'file_rejected', reason: 'format_not_allowed' });
  });
});
