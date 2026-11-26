import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIcs, foldLine } from '../src/workflow/ics';
import { Api, startApp, superDb } from './helpers';
import { actor } from './wf-helpers';

/** Contract 0.15.82: My Work as an iCalendar file. Session required; same rights as /me/tasks. */
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

describe('iCalendar writer', () => {
  it('writes all-day events, escapes text and skips tasks with no date', () => {
    const ics = buildIcs(
      [
        { id: 'a', site_code: 'S1', task_code: 'T1', name_en: 'Pour, cure; check', stage_code: 'CW', state: 'open', due: '2026-12-31' },
        { id: 'b', site_code: 'S2', task_code: 'T2', name_en: 'No date', stage_code: 'CW', state: 'open', due: null },
      ],
      new Date('2026-11-26T00:00:00Z'),
    );
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261231');
    expect(ics).toContain('DTEND;VALUE=DATE:20270101');
    expect(ics).toContain('Pour\\, cure\\; check');
    expect(ics).not.toContain('No date');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
  it('folds long lines at 75 octets', () => {
    const folded = foldLine(`SUMMARY:${'x'.repeat(200)}`);
    for (const l of folded.split('\r\n')) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
  });
});

describe('GET /me/tasks.ics', () => {
  it('refuses a call without a session', async () => {
    const res = await new Api(app).raw('get', '/me/tasks.ics');
    expect(res.status).toBe(401);
  });
  it('returns a calendar file for a signed-in user', async () => {
    const a = await actor(app, db, { level: 'entry', regions: [7] });
    const res = await a.api.raw('get', '/me/tasks.ics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.text.startsWith('BEGIN:VCALENDAR')).toBe(true);
  });
});
