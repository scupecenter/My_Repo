import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { actor } from './wf-helpers';

/** Item 17 (migration 0345, contract 0.15.246): the soft "… is editing this record" notice. Advisory only; no permission is involved. */
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

const RECORD = '11111111-2222-3333-4444-555555555555';

describe('edit presence (0.15.246, item 17)', () => {
  it('a heartbeat makes the editor visible to others, never to themself; stop removes it at once', async () => {
    const ann = await actor(app, db, { grants: [] });
    const ben = await actor(app, db, { grants: [] });

    // Invalid input is 422.
    expect((await ann.api.call('post', '/presence/editing', { kind: 'task', entity_id: RECORD })).status).toBe(422);
    expect((await ann.api.call('post', '/presence/editing', { kind: 'record', entity_id: 'nope' })).status).toBe(422);

    // Nobody edits yet.
    expect((await ben.api.call('get', `/presence/editing?kind=record&entity_id=${RECORD}`)).body.editors).toEqual([]);

    // Ann starts editing: ben sees her, ann does not see herself.
    expect((await ann.api.call('post', '/presence/editing', { kind: 'record', entity_id: RECORD })).status).toBe(200);
    const seen = await ben.api.call('get', `/presence/editing?kind=record&entity_id=${RECORD}`);
    expect(seen.status).toBe(200);
    expect(seen.body.editors).toHaveLength(1);
    expect(seen.body.editors[0]).toMatchObject({ id: ann.user.id });
    expect((await ann.api.call('get', `/presence/editing?kind=record&entity_id=${RECORD}`)).body.editors).toEqual([]);

    // Ben joins: each sees the other only.
    await ben.api.call('post', '/presence/editing', { kind: 'record', entity_id: RECORD });
    expect((await ann.api.call('get', `/presence/editing?kind=record&entity_id=${RECORD}`)).body.editors.map((e: { id: string }) => e.id)).toEqual([ben.user.id]);

    // Stop removes the row at once; a repeated stop is a no-op.
    expect((await ben.api.call('post', '/presence/editing/stop', { kind: 'record', entity_id: RECORD })).status).toBe(200);
    expect((await ben.api.call('post', '/presence/editing/stop', { kind: 'record', entity_id: RECORD })).status).toBe(200);
    expect((await ann.api.call('get', `/presence/editing?kind=record&entity_id=${RECORD}`)).body.editors).toEqual([]);
  });
});
