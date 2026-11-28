import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { actor, makeSite, makeTask, plainAdmin, type Actor } from './wf-helpers';

/** Private notes (migration 0668, contract 0.15.597): my own note on a task, readable by nobody else, a System Admin included. */
let app: NestExpressApplication;
let db: PgClient;
let me: Actor;
let other: Actor;
let admin: Actor;
let taskId: string;
const ZERO = '00000000-0000-4000-8000-000000000000';

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  me = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  other = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
  admin = await plainAdmin(app, db);
  taskId = await makeTask(db, await makeSite(db, 5), 'A1');
});
afterAll(async () => {
  await db.query(`DELETE FROM private_notes WHERE entity_id = $1`, [taskId]).catch(() => undefined);
  await db.end();
  await app.close();
});

const url = (type: string, id: string) => `/me/private-notes/${type}/${id}`;

describe('private notes', () => {
  it('starts empty, saves, reads back, and clears without deleting the row', async () => {
    const empty = await me.api.call('get', url('task', taskId));
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ entity_type: 'task', entity_id: taskId, body: '', updated_at: null });
    const saved = await me.api.call('put', url('task', taskId), { body: 'call the owner on Sunday' });
    expect(saved.status).toBe(200);
    expect(saved.body.body).toBe('call the owner on Sunday');
    expect((await me.api.call('get', url('task', taskId))).body.body).toBe('call the owner on Sunday');
    const cleared = await me.api.call('put', url('task', taskId), { body: '' });
    expect(cleared.body.body).toBe('');
    const rows = await db.query(`SELECT count(*)::int AS n FROM private_notes WHERE entity_id = $1`, [taskId]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('is private: another account and a System Admin see an empty note and cannot change mine', async () => {
    await me.api.call('put', url('task', taskId), { body: 'only mine' });
    for (const who of [other, admin]) {
      expect((await who.api.call('get', url('task', taskId))).body.body).toBe('');
    }
    await other.api.call('put', url('task', taskId), { body: 'theirs' });
    expect((await me.api.call('get', url('task', taskId))).body.body).toBe('only mine');
    expect((await other.api.call('get', url('task', taskId))).body.body).toBe('theirs');
  });

  it('refuses a record that does not exist, a wrong kind, a long note and an unknown field', async () => {
    expect((await me.api.call('put', url('task', ZERO), { body: 'x' })).status).toBe(404);
    expect((await me.api.call('get', url('site', taskId))).status).toBe(404);
    expect((await me.api.call('put', url('task', taskId), { body: 'x'.repeat(4001) })).status).toBe(422);
    expect((await me.api.call('put', url('task', taskId), { body: 'x', extra: 1 })).status).toBe(422);
  });

  it('the database never lets the app role read the table directly', async () => {
    const r = await db.query(`SELECT has_table_privilege('pmis_app', 'public.private_notes', 'SELECT') AS can`);
    expect(r.rows[0].can).toBe(false);
  });
});
