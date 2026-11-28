import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/** Migration 0412, contract 0.15.341: the site map on real tiles. The ui.features section map is closed, bounded, OFF by default, and the tile address is a path on this server only. */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let plain: Actor;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  plain = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [4], modules: null });
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const codes = (res: { body: any }): string[] => (res.body.errors ?? []).map((e: { path: string; code: string }) => `${e.path}:${e.code}`).sort();
const SEED = { enabled: false, tile_url: '', min_zoom: 0, max_zoom: 18, attribution: '', center_lat: 32.9, center_lon: 13.2, default_zoom: 6 };
const ON = { ...SEED, enabled: true, tile_url: '/tiles/{z}/{x}/{y}.png', attribution: 'Map data from the server owner' };

describe('Map tiles setting', () => {
  it('is off by default and readable by everyone signed in', async () => {
    const res = await plain.api.call('get', '/settings/ui-features');
    expect(res.status).toBe(200);
    expect(res.body.sections.map).toEqual(SEED);
  });

  it('rejects another website, a missing placeholder and a path climb; saves a same-server path with an audit row; a plain user cannot save', async () => {
    const cur = await admin.api.call('get', '/settings/ui-features');
    const tag = { 'If-Match': String(cur.headers.etag) };
    for (const url of ['https://tile.example.org/{z}/{x}/{y}.png', '//evil.example/{z}/{x}/{y}.png', '/tiles/{z}/{x}.png', '/tiles/../{z}/{x}/{y}.png']) {
      const bad = await admin.api.call('put', '/settings/ui-features', { sections: { map: { ...ON, tile_url: url } }, reason: 'Bad address' }, tag);
      expect(bad.status).toBe(422);
      expect(codes(bad).every((c) => c.startsWith('/sections/map'))).toBe(true);
    }
    const badZoom = await admin.api.call('put', '/settings/ui-features', { sections: { map: { ...ON, min_zoom: 10, max_zoom: 5, extra: 1 } }, reason: 'Bad zoom' }, tag);
    expect(badZoom.status).toBe(422);
    const ok = await admin.api.call('put', '/settings/ui-features', { sections: { map: ON }, reason: 'Turn the tile map on' }, tag);
    expect(ok.status).toBe(200);
    expect(ok.body.sections.map).toEqual(ON);
    const rows = await db.query("SELECT after FROM audit_log WHERE action = 'ui_features_update' ORDER BY id DESC LIMIT 1");
    expect(rows.rows[0]?.after?.map).toEqual(ON);
    expect((await plain.api.call('put', '/settings/ui-features', { sections: { map: ON }, reason: 'No' }, { 'If-Match': String(ok.headers.etag) })).status).toBe(403);
    const back = await admin.api.call('put', '/settings/ui-features', { sections: { map: SEED }, reason: 'Back to the default' }, { 'If-Match': String(ok.headers.etag) });
    expect(back.status).toBe(200);
  });
});
