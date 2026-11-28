import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/** Migration 0411, contract 0.15.340: Field mode. The ui.features section field_pwa is closed, complete, bounded and OFF by default; only an admin saves it. */
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
const ON = { enabled: true, cache_hours: 12, max_queue: 40, max_photo_mb: 6, sync_seconds: 30 };

describe('Field mode setting', () => {
  it('is off by default and readable by everyone signed in', async () => {
    const res = await plain.api.call('get', '/settings/ui-features');
    expect(res.status).toBe(200);
    expect(res.body.sections.field_pwa).toEqual({ enabled: false, cache_hours: 24, max_queue: 50, max_photo_mb: 8, sync_seconds: 60 });
  });

  it('validates: closed keys, integer bounds, boolean switch; saves with an audit row; a plain user cannot save', async () => {
    const cur = await admin.api.call('get', '/settings/ui-features');
    const tag = { 'If-Match': String(cur.headers.etag) };
    const bad = await admin.api.call('put', '/settings/ui-features', { sections: { field_pwa: { enabled: 'yes', cache_hours: 0, max_queue: 500, max_photo_mb: 8, sync_seconds: 60, extra: 1 } }, reason: 'Bad field' }, tag);
    expect(bad.status).toBe(422);
    expect(codes(bad).length).toBeGreaterThan(0);
    expect(codes(bad).every((c) => c.startsWith('/sections/field_pwa'))).toBe(true);
    const ok = await admin.api.call('put', '/settings/ui-features', { sections: { field_pwa: ON }, reason: 'Turn field mode on' }, tag);
    expect(ok.status).toBe(200);
    expect(ok.body.sections.field_pwa).toEqual(ON);
    const rows = await db.query("SELECT after FROM audit_log WHERE action = 'ui_features_update' ORDER BY id DESC LIMIT 1");
    expect(rows.rows[0]?.after?.field_pwa).toEqual(ON);
    expect((await plain.api.call('put', '/settings/ui-features', { sections: { field_pwa: ON }, reason: 'No' }, { 'If-Match': String(ok.headers.etag) })).status).toBe(403);
    const back = await admin.api.call('put', '/settings/ui-features', { sections: { field_pwa: { ...ON, enabled: false, cache_hours: 24, max_queue: 50, max_photo_mb: 8, sync_seconds: 60 } }, reason: 'Back to the default' }, { 'If-Match': String(ok.headers.etag) });
    expect(back.status).toBe(200);
  });
});
