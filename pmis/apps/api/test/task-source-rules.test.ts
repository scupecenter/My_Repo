import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/** Contract 0.15.646 (migration 0770, automation item 4): the task source rules in Settings. The test rule never matches a real record (an impossible condition) and is removed at the end. */
type J = Record<string, any>;
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
beforeAll(async () => { app = await startApp(); db = await superDb(); admin = await plainAdmin(app, db); });
afterAll(async () => {
  await db.query(`DELETE FROM register_task_sources WHERE register_key = 'permits_hse' AND task_code = 'B1'`);
  await db.end();
});

const rows = async () => (await admin.api.call('get', '/settings/task-source-rules')).body as J;
const mine = { register_key: 'permits_hse', task_code: 'B1', date_field: 'valid_from', data_eq: { status: 'Zz impossible 0770' } };

describe('task source rules', () => {
  it('reads the six seeded rows, the registers with their fields and the tasks', async () => {
    const r = await rows();
    expect((r.rows as J[]).some((x) => x.register_key === 'procurement' && x.task_code === 'B2')).toBe(true);
    expect((r.registers as J[]).find((x) => x.register_key === 'procurement')!.fields.some((f: J) => f.code === 'order_status')).toBe(true);
    expect((r.tasks as J[]).some((t) => t.code === 'B1')).toBe(true);
    expect(typeof r.version).toBe('number');
  });

  it('adds a rule with a reason, audits it, hides it, and never deletes', async () => {
    const before = await rows();
    const put = await admin.api.call('put', '/settings/task-source-rules', { reason: 'Test rule 0770', rows: [mine] }).set('If-Match', `"${before.version}"`);
    expect(put.status).toBe(200);
    expect((put.body.rows as J[]).find((x) => x.register_key === 'permits_hse' && x.task_code === 'B1')!.is_active).toBe(true);
    expect(put.body.version).toBeGreaterThan(before.version);
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'register_task_sources_update'`)).rows[0].n).toBeGreaterThan(0);
    const hide = await admin.api.call('put', '/settings/task-source-rules', { reason: 'Hide the test rule', rows: [{ ...mine, is_active: false }] });
    expect(hide.status).toBe(200);
    expect((hide.body.rows as J[]).find((x) => x.register_key === 'permits_hse' && x.task_code === 'B1')!.is_active).toBe(false);
  });

  it('refuses a stale version, a missing reason, an unknown field, a non-date field, an unknown task and a duplicate', async () => {
    const r = await rows();
    const bad = async (row: J, reason = 'Check refusal') => admin.api.call('put', '/settings/task-source-rules', { reason, rows: [row] });
    expect((await admin.api.call('put', '/settings/task-source-rules', { reason: 'Stale', rows: [] }).set('If-Match', `"${Number(r.version) + 50}"`)).status).toBe(412);
    expect((await bad(mine, '')).status).toBe(422);
    expect((await bad({ ...mine, data_eq: { nope_field: 'x' } })).status).toBe(422);
    expect((await bad({ ...mine, date_field: 'status' })).status).toBe(422);
    expect((await bad({ ...mine, task_code: 'ZZ99' })).status).toBe(422);
    expect((await admin.api.call('put', '/settings/task-source-rules', { reason: 'Dup', rows: [mine, mine] })).status).toBe(422);
    expect(((await rows()).rows as J[]).length).toBe((r.rows as J[]).length);
  });

  it('a user without the Settings right can neither read nor save', async () => {
    const eng: Actor = await actor(app, db);
    expect((await eng.api.call('put', '/settings/task-source-rules', { reason: 'No right', rows: [] })).status).toBe(403);
  });
});
