import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { actor } from './wf-helpers';

/** Contract 0.15.87: the editable map task code -> issue category and reason, and the derived "stopped at" rows (read only). */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
});

type Item = { task_code: string; category: string | null; is_active: boolean };

describe('issue category map', () => {
  it('a caller without admin.settings view is refused', async () => {
    const a = await actor(app, db, { grants: [['sites', 'view']] });
    expect((await a.api.call('get', '/settings/issue-task-map')).status).toBe(403);
  });

  it('is seeded for every task by its group and lists them with counts', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    const r = await api.call('get', '/settings/issue-task-map');
    expect(r.status).toBe(200);
    const items = r.body.items as Item[];
    expect(items.length).toBeGreaterThan(0);
    expect(r.body.counts.total).toBe(items.length);
    expect(items.find((i) => i.task_code === 'A3')?.category).toBe('Acquisition');
    expect(items.find((i) => i.task_code === 'C2')?.category).toBe('Power');
  });

  it('saves a change with a reason (audited), refuses a bad value, a short reason and an unknown task', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    const ok = await api.call('put', '/settings/issue-task-map/B3', { category: 'Civil', reason: null, is_active: true, why: 'Owner check of the map' });
    expect(ok.status).toBe(200);
    expect(ok.body.category).toBe('Civil');
    const back = await api.call('put', '/settings/issue-task-map/B3', { category: 'Access', reason: 'Access or Permit', is_active: true, why: 'Back to the seed value' });
    expect(back.status).toBe(200);
    expect((await api.call('put', '/settings/issue-task-map/B3', { category: 'NoSuchCategory', why: 'Testing the refusal' })).status).toBe(422);
    expect((await api.call('put', '/settings/issue-task-map/B3', { category: 'Civil', why: 'x' })).status).toBe(422);
    expect((await api.call('put', '/settings/issue-task-map/ZZ_NOPE', { category: 'Civil', why: 'Testing the refusal' })).status).toBe(422);
    const a = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'issue_task_map_saved' AND entity_id = 'B3'`);
    expect(a.rows[0].n).toBeGreaterThanOrEqual(2);
  });
});

describe('derived stopped rows', () => {
  it('answers a list with counts and never writes a register record', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    const before = await db.query(`SELECT count(*)::int AS n FROM register_records`);
    const r = await api.call('get', '/issues/stopped-rows');
    expect(r.status).toBe(200);
    expect(r.body.counts.total).toBe(r.body.items.length);
    for (const i of r.body.items as Array<{ why: string }>) expect(['late', 'rejected', 'suspended']).toContain(i.why);
    const after = await db.query(`SELECT count(*)::int AS n FROM register_records`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
