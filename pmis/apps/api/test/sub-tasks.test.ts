import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { G, PROC, createRec, team } from './reg-helpers';
import { actor, makeSite, makeTask } from './wf-helpers';

/**
 * 0.15.474 (migration 0620): sub-tasks under a task or a register record. Read = view of the parent in its region; write = entry level there;
 * the owner of a sub-task moves its own status and progress. The roll-up never changes the parent. Region 8.
 */
const REGION = 8;
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

describe('sub-tasks', () => {
  it('task: add, roll up, owner moves own line, the reader cannot write, a stranger sees nothing, remove hides', async () => {
    const s = await makeSite(db, REGION);
    const tid = await makeTask(db, s, 'A1', 'open');
    const entry = await actor(app, db, { level: 'entry', grants: G('sites', 'view', 'edit'), regions: [REGION], modules: null });
    const owner = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [REGION], modules: null });
    const stranger = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [1], modules: null });
    const path = `/sub-tasks/task/${tid}`;

    const a = (await entry.api.call('post', path, { title: 'Check the cable', owner_id: owner.user.id })).body;
    const b = (await entry.api.call('post', path, { title: 'Photo of the mast' })).body;
    expect(a.version).toBe(1);

    let list = (await owner.api.call('get', path)).body;
    expect(list.items).toHaveLength(2);
    expect(list.can_edit).toBe(false);
    expect(list.rollup).toEqual({ total: 2, done: 0, progress: 0 });
    expect(list.items.find((x: { id: string }) => x.id === a.id).mine).toBe(true);

    // the owner moves only the status and progress of their own line
    const own = await owner.api.call('patch', `${path}/${a.id}`, { progress: 100 }, { 'If-Match': '"1"' });
    expect(own.status).toBe(200);
    expect((await owner.api.call('patch', `${path}/${a.id}`, { title: 'new' }, { 'If-Match': '"2"' })).status).toBe(403);
    expect((await owner.api.call('patch', `${path}/${b.id}`, { progress: 10 }, { 'If-Match': '"1"' })).status).toBe(403);
    // a stale version is 412
    expect((await entry.api.call('patch', `${path}/${a.id}`, { progress: 50 }, { 'If-Match': '"1"' })).status).toBe(412);

    await entry.api.call('patch', `${path}/${b.id}`, { state: 'doing' }, { 'If-Match': '"1"' });
    list = (await entry.api.call('get', path)).body;
    expect(list.can_edit).toBe(true);
    expect(list.rollup).toEqual({ total: 2, done: 1, progress: 75 });
    const parent = await db.query(`SELECT state FROM task_instances WHERE id = $1`, [tid]);
    expect(parent.rows[0].state).toBe('open');

    expect((await stranger.api.call('get', path)).status).toBe(404);
    expect((await stranger.api.call('post', path, { title: 'x' })).status).toBe(404);
    expect((await entry.api.call('post', path, { title: '' })).status).toBe(422);
    expect((await entry.api.call('post', path, { title: 'x', owner_id: stranger.user.id })).status).toBe(422);
    expect((await entry.api.call('post', '/sub-tasks/other/' + tid, { title: 'x' })).status).toBe(422);

    expect((await entry.api.call('patch', `${path}/${b.id}`, { removed: true }, { 'If-Match': '"2"' })).status).toBe(200);
    list = (await entry.api.call('get', path)).body;
    expect(list.items).toHaveLength(1);
    const rows = await db.query(`SELECT removed_at FROM sub_tasks WHERE id = $1`, [b.id]);
    expect(rows.rows[0].removed_at).not.toBeNull();
    const audit = await db.query(`SELECT action FROM audit_log WHERE entity_type = 'sub_task' AND entity_id = $1 ORDER BY id`, [b.id]);
    expect(audit.rows.map((r: { action: string }) => r.action)).toEqual(['sub_task_create', 'sub_task_update', 'sub_task_remove']);
  });

  it('record: sub-tasks hang on the logical record and follow its register module', async () => {
    const t = await team(app, db, 'procurement', 'procurement', REGION);
    const reader = await actor(app, db, { level: 'view', grants: G('procurement', 'view'), regions: [REGION], modules: null });
    const rec = await createRec(t, PROC);
    const path = `/sub-tasks/record/${rec.entity_id}`;
    const made = await t.entry.api.call('post', path, { title: 'Chase the supplier', due_date: '2026-12-20' });
    expect(made.status).toBe(201);
    const list = (await reader.api.call('get', path)).body;
    expect(list.items[0].title).toBe('Chase the supplier');
    expect(list.can_edit).toBe(false);
    expect((await reader.api.call('post', path, { title: 'no' })).status).toBe(403);
  });
});
