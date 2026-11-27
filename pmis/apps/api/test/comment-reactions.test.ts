import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { G, PROC, createRec, recPath, team } from './reg-helpers';
import { actor, makeSite, makeTask } from './wf-helpers';

/**
 * PM item 18 (0.15.247, migration 0346): a 👍 "acknowledged" reaction and a resolved flag on task and register-record comments.
 * The bar is the same as commenting (reading the thread); a stranger gets 404. Region 7, shared with nobody else.
 */
const REGION = 7;
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
  await app.close();
});


describe('PM18 comment reactions and resolved', () => {
  it('task comment: two readers react, the flag is per-caller, resolve and reopen record who and when', async () => {
    const s = await makeSite(db, REGION);
    const tid = await makeTask(db, s, 'A1', 'open');
    const a = await actor(app, db, { level: 'entry', grants: G('sites', 'view', 'edit'), regions: [REGION], modules: null });
    const r1 = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [REGION], modules: null });
    const r2 = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [REGION], modules: null });

    const c = (await a.api.call('post', `/tasks/${tid}/comments`, { body: 'please confirm' })).body;
    expect((await r1.api.call('put', `/comments/${c.id}/reactions`, { emoji: '👍' })).status).toBe(204);
    // idempotent: reacting twice keeps one row
    expect((await r1.api.call('put', `/comments/${c.id}/reactions`, { emoji: '👍' })).status).toBe(204);
    expect((await r2.api.call('put', `/comments/${c.id}/reactions`, { emoji: '👍' })).status).toBe(204);

    let list = (await a.api.call('get', `/tasks/${tid}/comments`)).body.items;
    expect(list[0].reactions).toEqual([{ emoji: '👍', count: 2, mine: false }]);
    list = (await r1.api.call('get', `/tasks/${tid}/comments`)).body.items;
    expect(list[0].reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);

    expect((await r1.api.call('delete', `/comments/${c.id}/reactions`, { emoji: '👍' })).status).toBe(204);
    list = (await a.api.call('get', `/tasks/${tid}/comments`)).body.items;
    expect(list[0].reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);

    expect(list[0].resolved).toBeNull();
    expect((await r2.api.call('put', `/comments/${c.id}/resolved`)).status).toBe(204);
    list = (await a.api.call('get', `/tasks/${tid}/comments`)).body.items;
    expect(list[0].resolved.by.id).toBe(r2.user.id);
    expect(list[0].resolved.at).toBeTruthy();
    expect((await r2.api.call('delete', `/comments/${c.id}/resolved`)).status).toBe(204);
    list = (await a.api.call('get', `/tasks/${tid}/comments`)).body.items;
    expect(list[0].resolved).toBeNull();
  });

  it('register comment: reaction and resolved work the same, a stranger gets 404, an unsupported emoji is 422', async () => {
    const t = await team(app, db, 'procurement', 'procurement', REGION);
    const reader = await actor(app, db, { level: 'view', grants: G('procurement', 'view'), regions: [REGION], modules: null });
    const stranger = await actor(app, db, { level: 'view', grants: G('procurement', 'view'), regions: [1], modules: null });
    const rec = await createRec(t, PROC);
    const path = recPath('procurement', rec.id, '/comments');

    const c = (await t.entry.api.call('post', path, { body: 'order arrived?' })).body;
    expect((await reader.api.call('put', `/comments/${c.id}/reactions`, { emoji: '👍' })).status).toBe(204);
    const list = (await reader.api.call('get', path)).body.items;
    expect(list.at(-1).reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    expect((await reader.api.call('put', `/comments/${c.id}/resolved`)).status).toBe(204);
    expect((await reader.api.call('get', path)).body.items.at(-1).resolved.by.id).toBe(reader.user.id);

    expect((await stranger.api.call('put', `/comments/${c.id}/reactions`, { emoji: '👍' })).status).toBe(404);
    expect((await stranger.api.call('put', `/comments/${c.id}/resolved`)).status).toBe(404);
    expect((await reader.api.call('put', `/comments/${c.id}/reactions`, { emoji: '🎉' })).status).toBe(422);
    const missing = '00000000-0000-0000-0000-000000000000';
    expect((await reader.api.call('put', `/comments/${missing}/resolved`)).status).toBe(404);
  });
});
