import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { Actor, actor, groupWith, makeSite, makeTask, setCell } from './wf-helpers';

/** The Approvals inbox and the bulk actions. Region 6 (GM). */
const REGION = 6;
const PREFIX = `WFA${randomBytes(3).toString('hex').toUpperCase()}`;
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

const site = () => makeSite(db, REGION, { prefix: PREFIX });
const ids = (body: { items: { task: { id: string } }[] }): string[] => body.items.map((i) => i.task.id);
const ver = async (a: Actor, id: string): Promise<number> => (await a.api.call('get', `/tasks/${id}`)).body.version as number;

describe('GET /approvals', () => {
  it('lists the tasks where the caller can review or approve, with tabs, filters and paging', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const r = await actor(app, db, { level: 'review' });
    const a = await actor(app, db, { level: 'approve' });
    const s1 = await site();
    const s2 = await site();
    const rev = await makeTask(db, s1, 'A1', 'in_review');
    const app1 = await makeTask(db, s2, 'A1', 'in_approval');
    const other = await makeTask(db, s2, 'B1', 'in_review'); // nobody holds B1 in this region
    await setCell(db, 'A1', REGION, 'entry', { user: [e.user.id] });
    await setCell(db, 'A1', REGION, 'review', { user: [r.user.id, a.user.id] });
    await setCell(db, 'A1', REGION, 'approve', { user: [a.user.id] });
    await db.query(`INSERT INTO workflow_steps (task_id, level, action, acted_by) VALUES ($1, 1, 'submit', $2)`, [rev, e.user.id]);
    const dt = await db.query(`INSERT INTO document_types (code, name_en, updated_at) VALUES ($1, 'Inbox doc', now()) RETURNING id`, [`WFI${Date.now() % 100000}`]);
    await db.query(`INSERT INTO document_slots (task_id, site_id, region_id, doc_type_id, status) VALUES ($1, $2, $3, $4, 'in_review')`, [rev, s1.id, REGION, dt.rows[0].id]);

    const asR = await r.api.call('get', `/approvals?q=${PREFIX}`);
    expect(asR.status).toBe(200);
    expect(ids(asR.body)).toEqual([rev]);
    const item = asR.body.items[0];
    expect(item.level_kind).toBe('review');
    expect(item.submitted_by.id).toBe(e.user.id);
    expect(item.will_self_skip).toBe(false);
    expect(item.waiting_since).toBeTruthy();
    expect(item.task).toMatchObject({ id: rev, task_code: 'A1', state: 'in_review', site_code: s1.code });
    expect(item.documents_summary).toEqual([{ slot_id: expect.any(String), name: 'Inbox doc', status: 'in_review', file_count: 0 }]);
    expect(item.via_group).toBeUndefined();

    const asA = await a.api.call('get', `/approvals?q=${PREFIX}&limit=50`);
    expect(ids(asA.body).sort()).toEqual([rev, app1].sort());
    expect(ids((await a.api.call('get', `/approvals?q=${PREFIX}&tab=approve`)).body)).toEqual([app1]);
    expect(ids((await a.api.call('get', `/approvals?q=${PREFIX}&tab=review`)).body)).toEqual([rev]);
    expect(ids((await a.api.call('get', `/approvals?q=${PREFIX}&stage_code=MS1&region_id=${REGION}`)).body).sort()).toEqual([rev, app1].sort());
    expect(ids((await a.api.call('get', `/approvals?q=${PREFIX}&region_id=1`)).body)).toEqual([]);
    expect(ids((await a.api.call('get', `/approvals?q=${s2.code}`)).body)).toEqual([app1]);
    // not a holder of anything: empty; B1 is nobody's
    expect(ids((await e.api.call('get', `/approvals?q=${PREFIX}`)).body)).toEqual([]);
    expect(ids(asA.body)).not.toContain(other);

    const page1 = await a.api.call('get', `/approvals?q=${PREFIX}&limit=1`);
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.page.next_cursor).toBeTruthy();
    const page2 = await a.api.call('get', `/approvals?q=${PREFIX}&limit=1&cursor=${page1.body.page.next_cursor}`);
    expect(ids(page2.body)).not.toEqual(ids(page1.body));
    expect([...ids(page1.body), ...ids(page2.body)].sort()).toEqual([rev, app1].sort());

    for (const bad of ['tab=x', 'region_id=8', 'limit=500']) expect((await a.api.call('get', `/approvals?${bad}`)).status, bad).toBe(422);
  });

  it('refuses a caller without the Approvals module, hides tasks of other regions, and flags group levels and self-skip', async () => {
    const m1 = await actor(app, db, { level: 'approve' });
    const m2 = await actor(app, db, { level: 'approve' });
    const noApprovals = await actor(app, db, { level: 'approve', grants: [['sites', 'view']] });
    const elsewhere = await actor(app, db, { level: 'approve', regions: [1] });
    const group = await groupWith(db, [m1.user.id, m2.user.id]);
    const s = await site();
    const t = await makeTask(db, s, 'A1', 'in_review');
    await setCell(db, 'A1', REGION, 'review', { group: [group] });
    await setCell(db, 'A1', REGION, 'approve', { user: [m1.user.id] });

    const denied = await noApprovals.api.call('get', '/approvals');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('module_forbidden');
    expect((await noApprovals.api.call('post', '/approvals/bulk', { action: 'pass', items: [{ id: t, version: 1 }] })).status).toBe(403);
    expect(ids((await elsewhere.api.call('get', `/approvals?q=${PREFIX}`)).body)).toEqual([]);

    const g = await m1.api.call('get', `/approvals?q=${s.code}&group_only=true`);
    expect(ids(g.body)).toEqual([t]);
    expect(g.body.items[0].via_group.id).toBe(group);
    // m1 also holds the next level: passing the review skips it, and the inbox says so
    expect(g.body.items[0].will_self_skip).toBe(true);
    expect(ids((await m1.api.call('get', `/approvals?q=${s.code}&group_only=false`)).body)).toEqual([t]);
    // a task someone holds directly is not a group item
    const s2 = await site();
    await makeTask(db, s2, 'A1', 'in_approval');
    expect(ids((await m1.api.call('get', `/approvals?q=${s2.code}&group_only=true`)).body)).toEqual([]);
  });
});

describe('POST /approvals/bulk', () => {
  it('approves many tasks with one step-up: done, skipped (with a reason) and failed items in one answer', async () => {
    const a = await actor(app, db, { level: 'approve', stepUp: false });
    const stranger = await actor(app, db, { level: 'approve' });
    const e = await actor(app, db, { level: 'entry' });
    await setCell(db, 'A1', REGION, 'entry', { user: [e.user.id] });
    await setCell(db, 'A1', REGION, 'review', { user: [e.user.id] });
    await setCell(db, 'A1', REGION, 'approve', { user: [a.user.id] });
    const t1 = await makeTask(db, await site(), 'A1', 'in_approval', { actualDate: '2026-02-01' });
    const t2 = await makeTask(db, await site(), 'A1', 'in_approval', { actualDate: '2026-02-01' });
    const t3 = await makeTask(db, await site(), 'A1', 'in_approval', { actualDate: '2026-02-01' });
    const review = await makeTask(db, await site(), 'A1', 'in_review', { actualDate: '2026-02-01' });
    const body = (items: { id: string; version: number }[], action = 'approve') => ({ action, items });
    const items = [
      { id: t1, version: await ver(a, t1) },
      { id: t2, version: (await ver(a, t2)) + 7 }, // stale
      { id: t3, version: await ver(a, t3) },
      { id: review, version: await ver(a, review) }, // at the review level: not an approval
      { id: '11111111-1111-4111-8111-111111111111', version: 1 }, // unknown
      { id: t1, version: 1 }, // listed twice
    ];

    const noStep = await a.api.call('post', '/approvals/bulk', body(items));
    expect(noStep.status).toBe(401);
    expect(noStep.body.code).toBe('step_up_required');
    expect((await a.api.call('get', `/tasks/${t1}`)).body.state).toBe('in_approval');

    await a.api.stepUp(a.user.password);
    const key = `bulk-${randomBytes(6).toString('hex')}`;
    const res = await a.api.call('post', '/approvals/bulk', { ...body(items), note: 'bulk ok' }, { 'Idempotency-Key': key });
    expect(res.status).toBe(200);
    expect(res.body.bulk_action_id).toBeTruthy();
    expect(res.body.done.map((d: { id: string }) => d.id).sort()).toEqual([t1, t3].sort());
    const skipped = Object.fromEntries(res.body.skipped.map((x: { ref: string; code: string }) => [x.ref, x.code]));
    expect(skipped[review]).toBe('invalid_transition');
    expect(skipped[t1]).toBe('duplicate');
    const failed = Object.fromEntries(res.body.failed.map((x: { ref: string; code: string }) => [x.ref, x.code]));
    expect(failed[t2]).toBe('precondition_failed');
    expect(failed['11111111-1111-4111-8111-111111111111']).toBe('not_found');
    for (const id of [t1, t3]) expect((await a.api.call('get', `/tasks/${id}`)).body.state).toBe('approved');
    expect((await a.api.call('get', `/tasks/${t2}`)).body.state).toBe('in_approval');
    // each item was audited on its own
    const audit = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'task_approve' AND entity_id = ANY($1)`, [[t1, t3]]);
    expect(audit.rows[0].n).toBe(2);

    // a replay with the same key returns the first answer and does nothing again
    const replay = await a.api.call('post', '/approvals/bulk', { ...body(items), note: 'bulk ok' }, { 'Idempotency-Key': key });
    expect(replay.status).toBe(200);
    expect(replay.body.bulk_action_id).toBe(res.body.bulk_action_id);
    expect((await a.api.call('post', '/approvals/bulk', body(items.slice(0, 1)), { 'Idempotency-Key': key })).status).toBe(422);

    // someone who does not hold the level fails for that item
    const t4 = await makeTask(db, await site(), 'A1', 'in_approval', { actualDate: '2026-02-01' });
    const denied = await stranger.api.call('post', '/approvals/bulk', body([{ id: t4, version: await ver(a, t4) }]));
    expect(denied.status).toBe(200);
    expect(denied.body.done).toEqual([]);
    expect(denied.body.failed[0]).toMatchObject({ ref: t4, code: 'not_eligible_holder' });
    expect((await a.api.call('get', `/tasks/${t4}`)).body.state).toBe('in_approval');
  });

  it('passes review levels in bulk, and rejects a malformed request or a bulk rejection', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const r = await actor(app, db, { level: 'review' });
    const a = await actor(app, db, { level: 'approve' });
    await setCell(db, 'A1', REGION, 'entry', { user: [e.user.id] });
    await setCell(db, 'A1', REGION, 'review', { user: [r.user.id] });
    await setCell(db, 'A1', REGION, 'approve', { user: [a.user.id] });
    const t1 = await makeTask(db, await site(), 'A1', 'in_review', { actualDate: '2026-02-01' });
    const t2 = await makeTask(db, await site(), 'A1', 'in_approval', { actualDate: '2026-02-01' });
    const res = await r.api.call('post', '/approvals/bulk', { action: 'pass', items: [{ id: t1, version: await ver(r, t1) }, { id: t2, version: await ver(r, t2) }] });
    expect(res.status).toBe(200);
    expect(res.body.done.map((d: { id: string }) => d.id)).toEqual([t1]);
    expect(res.body.skipped.map((x: { ref: string; code: string }) => [x.ref, x.code])).toEqual([[t2, 'invalid_transition']]);
    expect((await r.api.call('get', `/tasks/${t1}`)).body.state).toBe('in_approval');

    for (const bad of [{ action: 'reject', items: [{ id: t1, version: 1 }] }, { action: 'pass', items: [] }, { action: 'pass' }, { action: 'pass', items: [{ id: 'x', version: 1 }] }]) {
      const res2 = await r.api.call('post', '/approvals/bulk', bad);
      expect(res2.status).toBe(422);
      expect(res2.body.code).toBe('validation_failed');
    }
  });
});
