import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { plainAdmin } from './wf-helpers';

/** Contract 0.15.99 (migration 0251): scheduled Master exports start when the owner opens Exports, never as a background job. */
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

type Item = { id: string; name: string; due: boolean; next_due_at: string; last_job_id: string | null; last_error: string | null };

describe('scheduled Master export', () => {
  it('saves, lists only the owner\'s own, refuses bad input and another person cannot change it', async () => {
    const a = await plainAdmin(app, db);
    const b = await plainAdmin(app, db);
    const put = (api: typeof a.api, body: unknown) => api.call('put', '/exports/schedules', body);
    expect((await put(a.api, { name: '', cadence: 'weekly', weekday: 1 })).status).toBe(422);
    expect((await put(a.api, { name: 'x', cadence: 'weekly' })).status).toBe(422);               // a weekday is needed
    expect((await put(a.api, { name: 'x', cadence: 'monthly', day_of_month: 31 })).status).toBe(422);
    expect((await put(a.api, { name: 'x', cadence: 'daily', spec: { view: {} } })).status).toBe(422);
    const ok = await put(a.api, { name: 'Weekly Master', cadence: 'weekly', weekday: 1 });
    expect(ok.status).toBe(200);
    const item = (ok.body.items as Item[]).find((i) => i.name === 'Weekly Master') as Item;
    expect(item.due).toBe(false);                                                                  // just created: the first run is the next Monday
    expect(new Date(item.next_due_at).getTime()).toBeGreaterThan(Date.now());
    expect(((await b.api.call('get', '/exports/schedules')).body.items as Item[]).some((i) => i.id === item.id)).toBe(false);
    expect((await put(b.api, { id: item.id, name: 'hijack', cadence: 'daily' })).status).toBe(404);
    expect((await b.api.call('delete', `/exports/schedules/${item.id}`)).status).toBe(404);
    const audit = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'export_schedule_save' AND entity_id = $1`, [item.id]);
    expect(audit.rows[0].n).toBe(1);
    expect((await a.api.call('delete', `/exports/schedules/${item.id}`)).status).toBe(200);
  });

  it('a due schedule starts when its owner opens the exports list, once, and a failing one records its error', async () => {
    const a = await plainAdmin(app, db);
    const made = await a.api.call('put', '/exports/schedules', { name: 'Daily part', cadence: 'daily', spec: { parts: ['sites'] } });
    const id = (made.body.items as Item[])[0]?.id as string;
    // pretend the schedule was created three days ago, so a day has passed
    await db.query(`UPDATE settings SET value = jsonb_set(value, '{items}', (SELECT jsonb_agg(CASE WHEN x ->> 'id' = $1 THEN x || jsonb_build_object('created_at', (now() - interval '3 days')::text) ELSE x END) FROM jsonb_array_elements(value -> 'items') x)) WHERE key = 'master_export.schedules'`, [id]);
    expect(((await a.api.call('get', '/exports/schedules')).body.items as Item[]).find((i) => i.id === id)?.due).toBe(true);
    expect((await a.api.call('get', '/exports/master')).status).toBe(200);
    const after = ((await a.api.call('get', '/exports/schedules')).body.items as Item[]).find((i) => i.id === id) as Item;
    expect(after.due).toBe(false);
    expect(after.last_error ?? null).toBeNull();
    expect(after.last_job_id).not.toBeNull();
    const list = await a.api.call('get', '/exports/master');
    expect((list.body.items as { id: string }[]).filter((j) => j.id === after.last_job_id).length).toBe(1);
    // a part that does not exist: the start is refused, the error is kept and the schedule moves on
    const bad = await a.api.call('put', '/exports/schedules', { name: 'Bad part', cadence: 'daily', spec: { parts: ['no_such_part'] } });
    const bid = (bad.body.items as Item[]).find((i) => i.name === 'Bad part')?.id as string;
    await db.query(`UPDATE settings SET value = jsonb_set(value, '{items}', (SELECT jsonb_agg(CASE WHEN x ->> 'id' = $1 THEN x || jsonb_build_object('created_at', (now() - interval '3 days')::text) ELSE x END) FROM jsonb_array_elements(value -> 'items') x)) WHERE key = 'master_export.schedules'`, [bid]);
    expect((await a.api.call('get', '/exports/master')).status).toBe(200);
    const failed = ((await a.api.call('get', '/exports/schedules')).body.items as Item[]).find((i) => i.id === bid) as Item;
    expect(failed.last_error).toBeTruthy();
    expect(failed.due).toBe(false);
  });
});
