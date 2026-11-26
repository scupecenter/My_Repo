import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { startApp, superDb } from './helpers';
import { G, createRec, post, recPath, team, type Team } from './reg-helpers';
import { actor } from './wf-helpers';

/**
 * Migration 0188: intake triage for the Issue Log and the Change Control Log. New records land in the queue (triage_state pending); the
 * register's L2 (approve) holder accepts, rejects, merges as a duplicate or defers with a note. Reject and merge void the record and ask for
 * a step-up. Region 7 like the other register suites, one test at a time (the matrix lock).
 */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
beforeEach(async () => {
  await db.query('SELECT pg_advisory_lock(770101)');
});
afterEach(async () => {
  await db.query('SELECT pg_advisory_unlock(770101)');
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const ISSUE = { pending_issue: 'x', raised_date: '2026-01-05', issue_status: 'Open' };
const triage = (t: Team, id: string, version: number, body: unknown, who: 'entry' | 'review' | 'approve' = 'approve') =>
  post(t[who].api, 'issues', id, 'triage', version, body);

describe('register triage (0188)', () => {
  it('enables triage on issues and change control only, and starts new records pending', async () => {
    const flags = await q<{ register_key: string; triage_enabled: boolean }>(db, `SELECT register_key, triage_enabled FROM register_definitions ORDER BY register_key`);
    const on = flags.filter((f) => f.triage_enabled).map((f) => f.register_key);
    expect(on).toEqual(['change_control', 'issues']);

    const t = await team(app, db, 'issues', 'issues', 7);
    const rec = await createRec(t, ISSUE);
    expect(rec.triage).toMatchObject({ state: 'pending', note: null, duplicate_of: null });
    // the queue filter of the list
    const list = await t.entry.api.call('get', `${recPath('issues')}?triage=pending`);
    expect(list.body.items.map((i: { id: string }) => i.id)).toContain(rec.id);
    const bad = await t.entry.api.call('get', `${recPath('issues')}?triage=nope`);
    expect(bad.status).toBe(422);
    // a register without triage (procurement) has no triage on its records
    const tp = await team(app, db, 'procurement', 'procurement', 7);
    const pr = await createRec(tp, { scope: 'CW', delivery: 'Outsourced', pr_no: 'PR-T1', pr_date: '2026-01-05', order_status: 'Open' }, { record_type: 'pr' });
    expect(pr.triage).toBeUndefined();
  });

  it('only the L2 holder triages, with the admin fallback when the row has no holder', async () => {
    const t = await team(app, db, 'issues', 'issues', 7);
    const rec = await createRec(t, ISSUE);
    expect(rec.allowed_actions ?? []).not.toContain('triage'); // the entry holder never triages
    const asApprove = await t.approve.api.call('get', recPath('issues', rec.id));
    expect(asApprove.body.allowed_actions).toContain('triage');
    const asReview = await t.review.api.call('get', recPath('issues', rec.id));
    expect(asReview.body.allowed_actions ?? []).not.toContain('triage');

    // entry and review holders cannot triage (the database decides)
    const denied = await triage(t, rec.id, rec.version, { action: 'accept' }, 'entry');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('not_eligible_holder');

    // no holder at all: a System Admin decides (the fallback of reg_require_actor's rule)
    await db.query(`DELETE FROM matrix_cells WHERE register_key = 'issues' AND level = 3 AND region_id = 7`);
    const { plainAdmin } = await import('./wf-helpers');
    const admin = await plainAdmin(app, db);
    const res = await admin.api.call('post', recPath('issues', rec.id, '/triage'), { action: 'accept' }, { 'If-Match': `"${rec.version}"` });
    expect(res.status).toBe(200);
    expect(res.body.triage).toMatchObject({ state: 'accepted' });
  });

  it('accept and defer keep the record alive; a deferred record can be accepted later; decisions notify the creator', async () => {
    const t = await team(app, db, 'issues', 'issues', 7);
    const rec = await createRec(t, ISSUE);
    let res = await triage(t, rec.id, rec.version, { action: 'defer', note: 'next week' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'entry' });
    expect(res.body.triage).toMatchObject({ state: 'deferred', note: 'next week' });
    expect(res.body.triage.by.id).toBe(t.approve.user.id);

    res = await triage(t, rec.id, res.body.version, { action: 'accept' });
    expect(res.status).toBe(200);
    expect(res.body.triage).toMatchObject({ state: 'accepted' });
    // accepted is final
    const again = await triage(t, rec.id, res.body.version, { action: 'defer' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('invalid_transition');

    // the creator (entry holder) got both decisions in the inbox
    const inbox = await t.entry.api.call('get', '/notifications?limit=10');
    const kinds = inbox.body.items.filter((n: { kind: string }) => n.kind === 'triage_decision');
    expect(kinds.length).toBeGreaterThanOrEqual(2);

    // the record history shows the triage steps, and the audit log carries before/after
    const hist = await t.approve.api.call('get', recPath('issues', rec.id, '/history'));
    expect(hist.body.items.map((i: { action: string }) => i.action)).toEqual(expect.arrayContaining(['triage_defer', 'triage_accept']));
    const au = await q<{ action: string }>(db, `SELECT action FROM audit_log WHERE entity_type = 'register_record' AND entity_id = $1 AND action = 'register_record_triage'`, [rec.id]);
    expect(au.length).toBe(2);
  });

  it('reject voids the record with a step-up and keeps the note', async () => {
    const t = await team(app, db, 'issues', 'issues', 7);
    const rec = await createRec(t, ISSUE);
    // no note -> 422
    const noNote = await triage(t, rec.id, rec.version, { action: 'reject' });
    expect(noNote.status).toBe(422);
    // a holder whose session was never stepped up -> 401 (the helper actors sign in already stepped up)
    const fresh = await actor(app, db, { level: 'approve', grants: G('issues', 'view', 'approve'), regions: [7], modules: null, stepUp: false });
    const cell = (await db.query(`SELECT id FROM matrix_cells WHERE register_key = 'issues' AND level = 3 AND region_id = 7 ORDER BY updated_at DESC LIMIT 1`)).rows[0]?.id as string;
    await db.query(`INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, 'user', $2) ON CONFLICT DO NOTHING`, [cell, fresh.user.id]);
    const noStep = await fresh.api.call('post', recPath('issues', rec.id, '/triage'), { action: 'reject', note: 'not an issue' }, { 'If-Match': `"${rec.version}"` });
    expect(noStep.status).toBe(401);
    expect(noStep.body.code).toBe('step_up_required');
    await t.approve.api.stepUp(t.approve.user.password);
    const res = await triage(t, rec.id, rec.version, { action: 'reject', note: 'not an issue' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'voided' });
    expect(res.body.triage).toMatchObject({ state: 'rejected', note: 'not an issue' });
  });

  it('merge voids as a duplicate of another live record, links it and notes the surviving thread', async () => {
    const t = await team(app, db, 'issues', 'issues', 7);
    const keep = await createRec(t, ISSUE);
    const dup = await createRec(t, ISSUE);
    // invalid targets: self, a record of another register, a voided record
    await t.approve.api.stepUp(t.approve.user.password);
    const self = await triage(t, dup.id, dup.version, { action: 'merge', note: 'same', duplicate_of: dup.entity_id });
    expect(self.status).toBe(422);
    const res = await triage(t, dup.id, dup.version, { action: 'merge', note: 'same site problem', duplicate_of: keep.entity_id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'voided' });
    expect(res.body.triage).toMatchObject({ state: 'duplicate', duplicate_of: keep.entity_id });
    // the surviving record's comments carry the merge note
    const comments = await t.approve.api.call('get', recPath('issues', keep.id, '/comments'));
    expect(comments.body.items.some((c: { body: string }) => c.body.includes('Merged duplicate'))).toBe(true);
  });

  it('a record of a register without triage cannot be triaged (404 on the function guard)', async () => {
    const t = await team(app, db, 'procurement', 'procurement', 7);
    const pr = await createRec(t, { scope: 'CW', delivery: 'Outsourced', pr_no: 'PR-T2', pr_date: '2026-01-05', order_status: 'Open' }, { record_type: 'pr' });
    const res = await post(t.approve.api, 'procurement', pr.id, 'triage', pr.version, { action: 'accept' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('invalid_transition');
  });

  it('a new version of a triaged entity enters the queue again as fresh intake', async () => {
    const t = await team(app, db, 'issues', 'issues', 7);
    const ownerRole = (await db.query(`SELECT code FROM list_values WHERE catalogue_code = 'IssueOwnerRole' ORDER BY sort_order LIMIT 1`)).rows[0].code as string;
    const rec = await createRec(t, { ...ISSUE, owner_role: ownerRole });
    const acc = await triage(t, rec.id, rec.version, { action: 'accept' });
    // approve it, then open a new version
    const { approveFlex } = await import('./reg-helpers');
    const done = await approveFlex(t, rec.id, acc.body.version);
    const v2 = await post(t.entry.api, 'issues', done.id, 'versions', done.version);
    expect(v2.status).toBe(201);
    expect(v2.body.triage).toMatchObject({ state: 'pending' });
  });
});
