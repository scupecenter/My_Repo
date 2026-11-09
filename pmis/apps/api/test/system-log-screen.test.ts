import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * The System Log screen (owner request 2026-11-09, contract 0.15.2, migration 0082): GET /system-log as the screen reads it (rights and filters), and the
 * saved views of the screen `system-log` (module admin.system_log). Rows are synthetic, under a source unique to this run.
 */
const TAG = randomBytes(3).toString('hex');
const SRC = `test-sl-${TAG}`;
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let viewer: Actor;
let plain: Actor;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db, false);
  viewer = await actor(app, db, { level: 'view', grants: G('admin.system_log', 'view'), stepUp: false });
  plain = await actor(app, db, { level: 'view', grants: G('sites', 'view'), stepUp: false });
  const rows: [string, string, string, Record<string, unknown>, string | null, string][] = [
    ['warn', SRC, 'template upload rejected: not_xlsx', { reason: 'not_xlsx', load_error: 'zip: end of data', file_name: 'a.xlsx', size: 12 }, `req-${TAG}-1`, '2026-11-08T10:00:00Z'],
    ['error', SRC, 'mail given up', { error: 'ECONNREFUSED' }, `req-${TAG}-2`, '2026-11-09T07:00:00Z'],
    ['info', SRC, 'daily job ran 100% fine', {}, null, '2026-11-09T09:30:00Z'],
    ['warn', `${SRC}-other`, 'template upload rejected: tpl_invalid', { reason: 'tpl_invalid' }, null, '2026-11-09T09:40:00Z'],
  ];
  for (const [level, source, message, ctx, req, at] of rows) {
    // system_log is append-only (no UPDATE): the fixture inserts each row with its time, as the migration role
    await db.query('INSERT INTO system_log (at, level, source, message, context, user_id, request_id) VALUES ($1::timestamptz, $2::"LogLevel", $3, $4, $5::jsonb, NULL, $6)',
      [at, level, source, message, JSON.stringify(ctx), req]);
  }
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const list = (who: Actor, qs: string) => who.api.call('get', `/system-log?${qs}`);
const msgs = (body: { items: { message: string }[] }) => body.items.map((i) => i.message);

describe('GET /system-log for the screen', () => {
  it('a System Admin and a holder of view on admin.system_log read it; anyone else gets 403', async () => {
    for (const who of [admin, viewer]) {
      const r = await list(who, `source=${SRC}`);
      expect(r.status).toBe(200);
      expect(msgs(r.body)).toEqual(['daily job ran 100% fine', 'mail given up', 'template upload rejected: not_xlsx']); // newest first
    }
    const r = await list(plain, `source=${SRC}`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('action_forbidden');
  });

  it('filters by level, source, text in the message (case-insensitive, % is literal), request ID and dates; the context comes back as details', async () => {
    expect(msgs((await list(admin, `source=${SRC}&level=error`)).body)).toEqual(['mail given up']);
    expect(msgs((await list(admin, `source=${SRC}-other`)).body)).toEqual(['template upload rejected: tpl_invalid']);
    expect(msgs((await list(admin, `source=${SRC}&q=NOT_XLSX`)).body)).toEqual(['template upload rejected: not_xlsx']);
    expect(msgs((await list(admin, `source=${SRC}&q=${encodeURIComponent('100%')}`)).body)).toEqual(['daily job ran 100% fine']);
    expect(msgs((await list(admin, `source=${SRC}&q=${encodeURIComponent('0% f')}`)).body)).toEqual(['daily job ran 100% fine']);
    expect(msgs((await list(admin, `q=req-${TAG}-2`)).body)).toEqual(['mail given up']);
    expect(msgs((await list(admin, `request_id=req-${TAG}-1`)).body)).toEqual(['template upload rejected: not_xlsx']);
    // a Tripoli calendar day as the screen sends it: from the start of the day (inclusive) to the start of the next (exclusive)
    const day = await list(admin, `source=${SRC}&from=${encodeURIComponent('2026-11-09T00:00:00+02:00')}&to=${encodeURIComponent('2026-11-10T00:00:00+02:00')}`);
    expect(msgs(day.body)).toEqual(['daily job ran 100% fine', 'mail given up']);
    const one = (await list(viewer, `source=${SRC}&level=warn`)).body.items[0];
    expect(one).toMatchObject({ level: 'warn', source: SRC, request_id: `req-${TAG}-1`, details: { reason: 'not_xlsx', load_error: 'zip: end of data', file_name: 'a.xlsx', size: 12 } });
    expect((await list(admin, 'level=fatal')).status).toBe(422);
  });
});

describe('saved views of the screen system-log (migration 0082)', () => {
  it('a reader of the System Log saves a view of the screen; someone without the right gets 403', async () => {
    const ok = await viewer.api.call('post', '/saved-views', { screen_key: 'system-log', name: `Rejected uploads ${TAG}`, filters: { level: 'warn', source: 'template-check' } });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ screen_key: 'system-log', is_owner: true, filters: { level: 'warn', source: 'template-check' } });
    expect((await viewer.api.call('get', '/saved-views?screen_key=system-log')).body.items.map((v: { id: string }) => v.id)).toContain(ok.body.id);
    expect((await admin.api.call('post', '/saved-views', { screen_key: 'system-log', name: `Errors ${TAG}` })).status).toBe(201);
    expect((await plain.api.call('post', '/saved-views', { screen_key: 'system-log', name: `Nope ${TAG}` })).status).toBe(403);
  });

  it('the side-menu catalogue holds logs.system in the heading logs', async () => {
    const r = await db.query(`SELECT default_group, added_in FROM nav_item_catalogue WHERE key = 'logs.system'`);
    expect(r.rows).toEqual([{ default_group: 'logs', added_in: '0082' }]);
  });
});
