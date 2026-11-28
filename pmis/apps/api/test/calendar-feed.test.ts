import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFeedIcs } from '../src/workflow/ics';
import { Api, startApp, superDb } from './helpers';
import { actor } from './wf-helpers';

/** Contract 0.15.460 (migration 0600): the personal, revocable calendar feed (D4). */
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

describe('feed writer', () => {
  it('writes all-day events and escapes text', () => {
    const ics = buildFeedIcs([{ uid: 'task-1', kind: 'planned', date: '2026-12-01', site_code: 'S1', title: 'Install, test', code: 'T1' }], new Date('2026-11-28T00:00:00Z'));
    expect(ics).toContain('DTSTART;VALUE=DATE:20261201');
    expect(ics).toContain('SUMMARY:S1 Install\\, test');
    expect(ics.endsWith('\r\n')).toBe(true);
  });
});

describe('personal calendar feed', () => {
  it('is off by default, needs a session to manage, and the link works without one until rotated or revoked', async () => {
    expect((await new Api(app).raw('get', '/me/calendar-feed')).status).toBe(401);
    const a = await actor(app, db, { level: 'entry', regions: [7] });
    expect((await a.api.call('get', '/me/calendar-feed')).body.enabled).toBe(false);
    const on = await a.api.call('post', '/me/calendar-feed', {});
    expect(on.status).toBe(200);
    const path = on.body.path as string;
    const read = await new Api(app).raw('get', path);
    expect(read.status).toBe(200);
    expect(read.headers['content-type']).toContain('text/calendar');
    expect(read.text.startsWith('BEGIN:VCALENDAR')).toBe(true);
    const status = await a.api.call('get', '/me/calendar-feed');
    expect(status.body.enabled).toBe(true);
    expect(JSON.stringify(status.body)).not.toContain(path.split('/').pop()!.slice(0, 20));
    // rotate: the old link stops at once
    const again = await a.api.call('post', '/me/calendar-feed', {});
    expect((await new Api(app).raw('get', path)).status).toBe(404);
    expect((await new Api(app).raw('get', again.body.path as string)).status).toBe(200);
    // revoke
    expect((await a.api.call('delete', '/me/calendar-feed')).status).toBe(200);
    expect((await new Api(app).raw('get', again.body.path as string)).status).toBe(404);
  });
  it('answers 404 for a malformed link', async () => {
    expect((await new Api(app).raw('get', '/me/calendar-feed/nope.ics')).status).toBe(404);
  });
});
