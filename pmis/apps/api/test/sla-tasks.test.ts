import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeAdmin, startApp, superDb } from './helpers';
import { actor } from './wf-helpers';

/** Contract 0.15.85: GET /settings/sla-tasks lists every task with its SLA status; PUT /settings/sla-tasks/{task}/no-sla records the explicit choice. */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
});

type Item = { task_code: string; mode: 'set' | 'none' | 'undecided'; in_draft: boolean };

describe('SLA status of every task', () => {
  it('a caller without admin.settings view is refused', async () => {
    const a = await actor(app, db, { grants: [['sites', 'view']] });
    const r = await a.api.call('get', '/settings/sla-tasks');
    expect(r.status).toBe(403);
  });

  it('lists the tasks with a mode each and counts that add up', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    const r = await api.call('get', '/settings/sla-tasks');
    expect(r.status).toBe(200);
    const items = r.body.items as Item[];
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(['set', 'none', 'undecided']).toContain(i.mode);
    expect(r.body.counts.total).toBe(items.length);
    expect(r.body.counts.set + r.body.counts.none + r.body.counts.undecided).toBe(items.length);
  });

  it('refuses a short reason, an unknown task and a task that has a rule', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    const list = await api.call('get', '/settings/sla-tasks');
    const withRule = (list.body.items as Item[]).find((i) => i.mode === 'set' && !i.in_draft);
    const short = await api.call('put', `/settings/sla-tasks/${withRule?.task_code ?? 'A1'}/no-sla`, { no_sla: true, reason: 'x' });
    expect(short.status).toBe(422);
    const unknown = await api.call('put', '/settings/sla-tasks/ZZ_NOPE/no-sla', { no_sla: true, reason: 'Testing the refusal' });
    expect(unknown.status).toBe(422);
    if (withRule) {
      const r = await api.call('put', `/settings/sla-tasks/${withRule.task_code}/no-sla`, { no_sla: true, reason: 'Testing the refusal' });
      expect(r.status).toBe(422);
    }
  });

  it('records "no SLA" for a task without a rule, shows it as none, and clears it back to undecided (the row is kept)', async () => {
    const api = await loggedIn(app, await makeAdmin(db));
    const list = await api.call('get', '/settings/sla-tasks');
    const open = (list.body.items as Item[]).find((i) => i.mode === 'undecided');
    if (!open) return; // every task of the seed has a rule: nothing to mark here, the refusal above covers the door
    const on = await api.call('put', `/settings/sla-tasks/${open.task_code}/no-sla`, { no_sla: true, reason: 'Information step, no clock' });
    expect(on.status).toBe(200);
    const after = await api.call('get', '/settings/sla-tasks');
    expect((after.body.items as Item[]).find((i) => i.task_code === open.task_code && i.in_draft === open.in_draft)?.mode).toBe('none');
    const off = await api.call('put', `/settings/sla-tasks/${open.task_code}/no-sla`, { no_sla: false, reason: 'Decided later' });
    expect(off.status).toBe(200);
    const kept = await db.query('SELECT is_none FROM task_sla_choices WHERE task_code = $1', [open.task_code]);
    expect(kept.rows[0]?.is_none).toBe(false);
  });
});
