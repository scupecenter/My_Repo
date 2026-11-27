import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * Migration 0370, contract 0.15.270: the Data hub. The setting section data_hub of ui.features is closed and complete; GET /data-hub/summary answers every
 * signed-in user with what concerns them; "your last downloads" reads only the caller's own template_download audit rows.
 */
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
const HUB = { widgets: { quick_bar: true, batches: true, template_changes: false, recent: true, health: true, admin: true }, badge: false, default_view: { templates: 'rows', uploads: 'table', exports: 'compact', master_import: 'table' } };

describe('Data hub', () => {
  it('validates the data_hub section: closed, complete, known views only', async () => {
    const cur = await admin.api.call('get', '/settings/ui-features');
    const tag = { 'If-Match': String(cur.headers.etag) };
    const bad = await admin.api.call('put', '/settings/ui-features', { sections: { data_hub: { widgets: { quick_bar: 'yes' }, badge: true, default_view: { templates: 'grid' } } }, reason: 'Bad hub' }, tag);
    expect(bad.status).toBe(422);
    expect(codes(bad).every((c) => c.startsWith('/sections/data_hub'))).toBe(true);
    expect(codes(bad).length).toBeGreaterThan(0);
    const ok = await admin.api.call('put', '/settings/ui-features', { sections: { data_hub: HUB }, reason: 'Hide template changes' }, tag);
    expect(ok.status).toBe(200);
    expect(ok.body.sections.data_hub).toEqual(HUB);
    expect((await plain.api.call('put', '/settings/ui-features', { sections: { data_hub: HUB }, reason: 'No' }, { 'If-Match': String(ok.headers.etag) })).status).toBe(403);
  });

  it('summary: empty for a person with nothing waiting; last downloads are the caller own', async () => {
    const empty = await plain.api.call('get', '/data-hub/summary');
    expect(empty.status).toBe(200);
    expect(empty.body.batches).toEqual({ count: 0, items: [] });
    expect(empty.body.my_downloads).toEqual([]);
    const tpl = (await db.query(`SELECT template_id FROM templates LIMIT 1`)).rows[0]?.template_id as string | undefined;
    if (!tpl) return;
    await db.query(`INSERT INTO audit_log (action, entity_type, entity_id, actor_id, after) VALUES ('template_download', 'template', $1, $2, '{"version": 1, "prefill": true}'::jsonb)`, [tpl, plain.user.id]);
    await db.query(`INSERT INTO audit_log (action, entity_type, entity_id, actor_id, after) VALUES ('template_download', 'template', $1, $2, '{"version": 1}'::jsonb)`, [tpl, admin.user.id]);
    const mine = await plain.api.call('get', '/data-hub/summary');
    expect(mine.body.my_downloads).toHaveLength(1);
    expect(mine.body.my_downloads[0]).toMatchObject({ template_id: tpl, version: 1, prefill: true });
    const theirs = await admin.api.call('get', '/data-hub/summary');
    expect(theirs.body.my_downloads.every((d: { prefill: boolean }) => d.prefill === false)).toBe(true);
  });
});
