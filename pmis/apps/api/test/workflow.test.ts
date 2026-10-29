import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { Actor, actor, groupWith, makeSite, makeTask, plainAdmin, setCell, etag } from './wf-helpers';

/**
 * The approval engine: Entry -> Review -> Approve, path snapshot (B7), self-skip and self-approval (B5), rejection after a skip (B6),
 * no holder (B10), group claim, all-members votes, optimistic locking, audit. Region 5 (Benghazi) and the tasks A1..A4 of workflow v1;
 * every test builds its own site, users and matrix cells.
 */
const REGION = 5;
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

interface Flow {
  site: { id: string; code: string; region: number };
  taskId: string;
}

/** A task of the site in the given state with the holders of the three levels. */
async function flow(code: string, holders: { entry: Actor[]; review: Actor[]; approve: Actor[] }, state = 'open', actualDate: string | null = '2026-01-05'): Promise<Flow> {
  const site = await makeSite(db, REGION);
  const taskId = await makeTask(db, site, code, state, { actualDate });
  for (const kind of ['entry', 'review', 'approve'] as const) {
    await setCell(db, code, REGION, kind, { user: holders[kind].map((h) => h.user.id) });
  }
  return { site, taskId };
}

const get = async (a: Actor, id: string) => (await a.api.call('get', `/tasks/${id}`)).body;
const act = (a: Actor, id: string, verb: string, version: number | string, body: unknown = {}) =>
  a.api.call('post', `/tasks/${id}/${verb}`, body, { 'If-Match': `"${version}"` });

describe('three levels with three different people', () => {
  it('start, submit, review and approve; approval needs step-up; the successors unlock', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const r = await actor(app, db, { level: 'review' });
    const a = await actor(app, db, { level: 'approve', stepUp: false });
    const f = await flow('A1', { entry: [e], review: [r], approve: [a] });
    const site = f.site;
    const a2 = await makeTask(db, site, 'A2', 'locked');
    await setCell(db, 'A2', REGION, 'entry', { user: [e.user.id] });
    const a3 = await makeTask(db, site, 'A3', 'locked');
    const a4 = await makeTask(db, site, 'A4', 'locked');

    const t = await get(e, f.taskId);
    expect(t.state).toBe('open');
    expect(t.levels_required).toBe(3);
    expect(t.allowed_actions.map((x: { action: string }) => x.action)).toContain('start');
    expect(t.ball_in_court.level_kind).toBe('entry');

    let res = await act(e, f.taskId, 'start', t.version);
    expect(res.status).toBe(200);
    expect(res.body.task.state).toBe('entry');
    expect(res.body.task.actual_start).toBeTruthy();
    expect(etag(res)).toBe(`"${res.body.task.version}"`);

    res = await act(e, f.taskId, 'submit', res.body.task.version, { note: 'ready' });
    expect(res.status).toBe(200);
    expect(res.body.task.state).toBe('in_review');
    expect(res.body.task.current_level).toBe(2);
    expect(res.body.skipped_levels).toEqual([]);

    // the entry holder cannot also review, the reviewer can
    expect((await act(e, f.taskId, 'review', res.body.task.version)).status).toBe(403);
    res = await act(r, f.taskId, 'review', res.body.task.version);
    expect(res.status).toBe(200);
    expect(res.body.task.state).toBe('in_approval');

    // final approval: step-up first
    const tVer = res.body.task.version;
    const noStep = await act(a, f.taskId, 'approve', tVer);
    expect(noStep.status).toBe(401);
    expect(noStep.body.code).toBe('step_up_required');
    expect((await a.api.stepUp(a.user.password)).status).toBe(200);
    res = await act(a, f.taskId, 'approve', tVer);
    expect(res.status).toBe(200);
    expect(res.body.task.state).toBe('approved');
    expect(res.body.task.approved_date).toBeTruthy();
    expect(res.body.unlocked_task_ids.sort()).toEqual([a2, a3].sort());
    // A4 needs A2 as well
    expect((await get(e, a4)).state).toBe('locked');
    expect((await get(e, a4)).lock_reasons[0].ref_code).toBe('A2');
    expect((await get(e, a2)).state).toBe('open');

    const hist = await e.api.call('get', `/tasks/${f.taskId}/history`);
    expect(hist.body.items.map((x: { action: string }) => x.action)).toEqual(['start', 'submit', 'review', 'approve']);
    expect(hist.body.items[3].stepup_verified).toBe(true);

    // audit with before and after values
    const audit = await db.query(`SELECT action, before, after, actor_id FROM audit_log WHERE entity_type = 'task' AND entity_id = $1 ORDER BY id`, [f.taskId]);
    expect(audit.rows.map((x) => x.action)).toEqual(['task_start', 'task_submit', 'task_review', 'task_approve']);
    const approve = audit.rows[3];
    expect(approve.before.state).toBe('in_approval');
    expect(approve.after.state).toBe('approved');
    expect(approve.actor_id).toBe(a.user.id);
    const unlockAudit = await db.query(`SELECT before, after FROM audit_log WHERE action = 'task_unlock' AND entity_id = $1`, [a2]);
    expect(unlockAudit.rows[0].before.state).toBe('locked');
    expect(unlockAudit.rows[0].after.state).toBe('open');
  });

  it('refuses a stale or missing If-Match, a user who is not a holder, and a user outside the region or module', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const other = await actor(app, db, { level: 'entry' });
    const elsewhere = await actor(app, db, { level: 'entry', regions: [1] });
    const noModule = await actor(app, db, { level: 'entry', grants: [['warehouse', 'view']] });
    const viewOnly = await actor(app, db, { level: 'entry', grants: [['sites', 'view']] });
    const f = await flow('A1', { entry: [e, viewOnly], review: [e], approve: [e] });
    const t = await get(e, f.taskId);

    const missing = await e.api.call('post', `/tasks/${f.taskId}/start`, {});
    expect(missing.status).toBe(428);
    expect(missing.body.code).toBe('precondition_required');
    const stale = await act(e, f.taskId, 'start', t.version + 5);
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('precondition_failed');

    const notHolder = await act(other, f.taskId, 'start', t.version);
    expect(notHolder.status).toBe(403);
    expect(notHolder.body.code).toBe('not_eligible_holder');
    const wrongRegion = await act(elsewhere, f.taskId, 'start', t.version);
    expect(wrongRegion.status).toBe(404);
    expect((await elsewhere.api.call('get', `/tasks/${f.taskId}`)).status).toBe(404);
    const wrongModule = await noModule.api.call('get', `/tasks/${f.taskId}`);
    expect(wrongModule.status).toBe(403);
    expect(wrongModule.body.code).toBe('module_forbidden');
    // a holder of the cell who lacks the edit grant is refused by the grid, not by the matrix
    const noEdit = await act(viewOnly, f.taskId, 'start', t.version);
    expect(noEdit.status).toBe(403);
    expect(noEdit.body.code).toBe('action_forbidden');

    expect((await act(e, f.taskId, 'start', t.version)).status).toBe(200);
    // the same version again: stale now
    expect((await act(e, f.taskId, 'start', t.version)).status).toBe(412);
    // the state no longer allows start
    const t2 = await get(e, f.taskId);
    const wrongState = await act(e, f.taskId, 'start', t2.version);
    expect(wrongState.status).toBe(409);
    expect(wrongState.body.code).toBe('invalid_transition');
  });

  it('saves entry data and refuses a future actual date; submit lists the missing fields and slots', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const f = await flow('A1', { entry: [e], review: [e], approve: [e] }, 'entry', null);
    let t = await get(e, f.taskId);
    expect(t.missing_for_submit).toEqual(['actual_date']);
    const submit = t.allowed_actions.find((x: { action: string }) => x.action === 'submit');
    expect(submit.disabled_reason).toContain('actual_date');
    let res = await act(e, f.taskId, 'submit', t.version);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('mandatory_fields_missing');
    expect(res.body.missing).toEqual(['actual_date']);

    const future = await e.api.call('patch', `/tasks/${f.taskId}`, { actual_date: '2035-12-30' }, { 'If-Match': `"${t.version}"` });
    expect(future.status).toBe(422);
    expect(future.body.errors[0].path).toBe('/actual_date');
    const noIfMatch = await e.api.call('patch', `/tasks/${f.taskId}`, { actual_date: '2026-01-05' });
    expect(noIfMatch.status).toBe(428);
    const empty = await e.api.call('patch', `/tasks/${f.taskId}`, {}, { 'If-Match': `"${t.version}"` });
    expect(empty.status).toBe(422);
    const saved = await e.api.call('patch', `/tasks/${f.taskId}`, { actual_date: '2026-01-05', values: { result: 'ok' } }, { 'If-Match': `"${t.version}"` });
    expect(saved.status).toBe(200);
    expect(saved.body.actual_date).toBe('2026-01-05');
    expect(saved.body.values.result).toBe('ok');
    expect(saved.body.version).toBe(t.version + 1);

    // a mandatory document type placed on the task blocks the submission until its slot has a file
    const dt = await db.query(`INSERT INTO document_types (code, name_en, updated_at) VALUES ($1, 'Test doc', now()) RETURNING id`, [`WFD${Date.now() % 100000}`]);
    const docCode = (await db.query('SELECT code FROM document_types WHERE id = $1', [dt.rows[0].id])).rows[0].code as string;
    const td = await db.query(`SELECT id FROM task_definitions td WHERE code = 'A1' AND workflow_id = (SELECT id FROM workflow_definitions WHERE version = 1)`);
    await db.query(`INSERT INTO document_type_placements (doc_type_id, kind, task_def_id) VALUES ($1, 'task', $2)`, [dt.rows[0].id, td.rows[0].id]);
    try {
      t = await get(e, f.taskId);
      expect(t.missing_for_submit).toEqual([docCode]);
      res = await act(e, f.taskId, 'submit', t.version);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('mandatory_slots_missing');
      expect(res.body.missing).toEqual([docCode]);
    } finally {
      await db.query('DELETE FROM document_type_placements WHERE doc_type_id = $1', [dt.rows[0].id]);
    }
  });
});

describe('self-skip and self-approval (B5)', () => {
  it('skips the review level when the submitter also holds it, logs the skip and goes to the approver', async () => {
    const p = await actor(app, db, { level: 'review' });
    const q = await actor(app, db, { level: 'approve' });
    const f = await flow('A1', { entry: [p], review: [p], approve: [q] }, 'entry');
    const t = await get(p, f.taskId);
    const submit = t.allowed_actions.find((x: { action: string }) => x.action === 'submit');
    expect(submit.will_skip_to).toBe(3);
    expect(submit.final).toBe(false);
    expect(t.approval_path[1].will_skip).toBe(true);

    const res = await act(p, f.taskId, 'submit', t.version);
    expect(res.status).toBe(200);
    expect(res.body.skipped_levels).toEqual([2]);
    expect(res.body.task.state).toBe('in_approval');
    expect(res.body.task.approval_path.map((l: { status: string }) => l.status)).toEqual(['done', 'skipped', 'current']);
    const hist = await p.api.call('get', `/tasks/${f.taskId}/history`);
    expect(hist.body.items.map((x: { action: string; level: number }) => `${x.action}:${x.level}`)).toEqual(['submit:1', 'auto_skip:2']);
    expect(hist.body.items[1].note).toBe('level skipped: same holder');
    expect(hist.body.items[1].self_approval).toBe(false);
    const audit = await db.query(`SELECT action, after FROM audit_log WHERE entity_id = $1 AND action = 'task_auto_skip'`, [f.taskId]);
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].after.level).toBe(2);
  });

  it('a person who holds every level approves with their submission: step-up, flagged as self-approval', async () => {
    const p = await actor(app, db, { level: 'approve', stepUp: false });
    const f = await flow('A1', { entry: [p], review: [p], approve: [p] }, 'entry');
    const t = await get(p, f.taskId);
    const submit = t.allowed_actions.find((x: { action: string }) => x.action === 'submit');
    expect(submit).toMatchObject({ final: true, step_up: true });

    const blocked = await act(p, f.taskId, 'submit', t.version);
    expect(blocked.status).toBe(401);
    expect(blocked.body.code).toBe('step_up_required');
    expect((await get(p, f.taskId)).state).toBe('entry'); // nothing happened

    await p.api.stepUp(p.user.password);
    const res = await act(p, f.taskId, 'submit', t.version);
    expect(res.status).toBe(200);
    expect(res.body.task.state).toBe('approved');
    expect(res.body.skipped_levels).toEqual([2, 3]);
    const hist = await p.api.call('get', `/tasks/${f.taskId}/history`);
    expect(hist.body.items.map((x: { action: string }) => x.action)).toEqual(['submit', 'auto_skip', 'auto_skip']);
    expect(hist.body.items.every((x: { self_approval: boolean }) => x.self_approval)).toBe(true);
    expect(hist.body.items[0].stepup_verified).toBe(true);
    const row = await db.query('SELECT self_approval FROM task_instances WHERE id = $1', [f.taskId]);
    expect(row.rows[0].self_approval).toBe(true);
    const audit = await db.query(`SELECT after FROM audit_log WHERE entity_id = $1 AND action = 'task_submit'`, [f.taskId]);
    expect(audit.rows[0].after.self_approval_flag).toBe(true);
    expect(audit.rows[0].after.state).toBe('approved');
  });

  it('the reviewer who also holds the approve level completes the task with the review: step-up, flagged', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const p = await actor(app, db, { level: 'approve', stepUp: false });
    const f = await flow('A1', { entry: [e], review: [p], approve: [p] }, 'in_review');
    const t = await get(p, f.taskId);
    expect(t.allowed_actions.find((x: { action: string }) => x.action === 'review')).toMatchObject({ final: true, step_up: true });
    const blocked = await act(p, f.taskId, 'review', t.version);
    expect(blocked.status).toBe(401);
    expect(blocked.body.step_up_method).toBe('password');
    await p.api.stepUp(p.user.password);
    const res = await act(p, f.taskId, 'review', t.version);
    expect(res.status).toBe(200);
    expect(res.body.task.state).toBe('approved');
    expect(res.body.skipped_levels).toEqual([3]);
    const hist = await p.api.call('get', `/tasks/${f.taskId}/history`);
    expect(hist.body.items.map((x: { action: string; self_approval: boolean }) => `${x.action}:${x.self_approval}`)).toEqual(['review:true', 'auto_skip:true']);
  });

  it('a one-level task: the submission is the final approval and needs step-up', async () => {
    const p = await actor(app, db, { level: 'approve' });
    const f = await flow('A3', { entry: [p], review: [], approve: [] }, 'entry');
    await db.query(`UPDATE task_definitions SET approval_levels = 1 WHERE code = 'A3' AND workflow_id = (SELECT id FROM workflow_definitions WHERE version = 1)`);
    try {
      const t = await get(p, f.taskId);
      expect(t.levels_required).toBe(1);
      const res = await act(p, f.taskId, 'submit', t.version);
      expect(res.status).toBe(200);
      expect(res.body.task.state).toBe('approved');
      expect(res.body.task.self_approval).toBeUndefined();
      const row = await db.query('SELECT self_approval, levels_required FROM task_instances WHERE id = $1', [f.taskId]);
      expect(row.rows[0]).toEqual({ self_approval: true, levels_required: 1 });
    } finally {
      await db.query(`UPDATE task_definitions SET approval_levels = NULL WHERE code = 'A3' AND workflow_id = (SELECT id FROM workflow_definitions WHERE version = 1)`);
    }
  });
});

describe('rejection one level back (B6)', () => {
  it('needs a note, goes one level back to the person who acted, and keeps the note in the comment thread', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const r = await actor(app, db, { level: 'review' });
    const a = await actor(app, db, { level: 'approve' });
    const f = await flow('A1', { entry: [e], review: [r], approve: [a] }, 'entry');
    let t = await get(e, f.taskId);
    t = (await act(e, f.taskId, 'submit', t.version)).body.task;
    t = (await act(r, f.taskId, 'review', t.version)).body.task;
    expect(t.state).toBe('in_approval');

    const noNote = await act(a, f.taskId, 'reject', t.version, {});
    expect(noNote.status).toBe(422);
    expect(noNote.body.code).toBe('note_required');
    expect((await act(a, f.taskId, 'reject', t.version, { note: '   ' })).status).toBe(422);
    // the entry holder cannot reject at the approve level
    expect((await act(e, f.taskId, 'reject', t.version, { note: 'x' })).status).toBe(403);

    const rej = await act(a, f.taskId, 'reject', t.version, { note: 'date does not match the SAR' });
    expect(rej.status).toBe(200);
    expect(rej.body.returned_to_level).toBe(2);
    expect(rej.body.task.state).toBe('in_review');
    expect(rej.body.task.return_count).toBe(1);
    expect(rej.body.task.last_return_note).toBe('date does not match the SAR');
    expect(rej.body.task.ball_in_court.claimed_by.id).toBe(r.user.id);

    const comments = await e.api.call('get', `/tasks/${f.taskId}/comments`);
    expect(comments.body.items).toHaveLength(1);
    expect(comments.body.items[0]).toMatchObject({ body: 'date does not match the SAR', is_rejection_note: true });
    expect(comments.body.items[0].author.id).toBe(a.user.id);

    // the reviewer rejects too: back to entry
    const rej2 = await act(r, f.taskId, 'reject', rej.body.task.version, { note: 'attach the signed form', rejected_slots: [] });
    expect(rej2.body.task.state).toBe('entry');
    expect(rej2.body.task.current_level).toBe(1);
    expect(rej2.body.task.return_count).toBe(2);
    // entry level cannot be rejected
    expect((await act(e, f.taskId, 'reject', rej2.body.task.version, { note: 'x' })).status).toBe(409);
    const notif = await db.query(`SELECT user_id, kind FROM notifications WHERE task_id = $1 AND kind = 'task_rejected' ORDER BY created_at`, [f.taskId]);
    expect(notif.rows.map((n) => n.user_id)).toEqual([r.user.id, e.user.id]);
    const audit = await db.query(`SELECT before, after, reason FROM audit_log WHERE entity_id = $1 AND action = 'task_reject' ORDER BY id`, [f.taskId]);
    expect(audit.rows[0].before.state).toBe('in_approval');
    expect(audit.rows[0].after.state).toBe('in_review');
    expect(audit.rows[0].reason).toBe('date does not match the SAR');
  });

  it('after a skip the rejection returns to the person who actually acted, who resubmits; the skip is applied and logged again', async () => {
    const p = await actor(app, db, { level: 'review' }); // holds entry and review
    const colleague = await actor(app, db, { level: 'entry' }); // also an entry holder, must not receive the task
    const q = await actor(app, db, { level: 'approve' });
    const f = await flow('A1', { entry: [p, colleague], review: [p], approve: [q] }, 'entry');
    let t = await get(p, f.taskId);
    let res = await act(p, f.taskId, 'submit', t.version);
    expect(res.body.skipped_levels).toEqual([2]);
    t = res.body.task;

    res = await act(q, f.taskId, 'reject', t.version, { note: 'wrong coordinates' });
    expect(res.status).toBe(200);
    // not level 2 (skipped), but level 1, pinned to P
    expect(res.body.returned_to_level).toBe(1);
    expect(res.body.task.state).toBe('entry');
    expect(res.body.task.ball_in_court.claimed_by.id).toBe(p.user.id);
    t = res.body.task;

    // the colleague holds the entry level but the task is with P
    const taken = await act(colleague, f.taskId, 'submit', t.version);
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('already_claimed');
    expect(taken.body.claimed_by.id).toBe(p.user.id);

    res = await act(p, f.taskId, 'submit', t.version, { note: 'fixed' });
    expect(res.status).toBe(200);
    expect(res.body.skipped_levels).toEqual([2]);
    expect(res.body.task.state).toBe('in_approval');
    const hist = await p.api.call('get', `/tasks/${f.taskId}/history`);
    expect(hist.body.items.map((x: { action: string; level: number }) => `${x.action}:${x.level}`)).toEqual([
      'submit:1', 'auto_skip:2', 'reject:3', 'submit:1', 'auto_skip:2',
    ]);
    const skips = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'task_auto_skip'`, [f.taskId]);
    expect(skips.rows[0].n).toBe(2);
  });
});

describe('the level path is snapshotted at the first submission (B7)', () => {
  it('a change of the number of levels reaches tasks not yet submitted, not the one in flight, also after a rejection', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const r = await actor(app, db, { level: 'review' });
    const a = await actor(app, db, { level: 'approve' });
    const f = await flow('A2', { entry: [e], review: [r], approve: [a] }, 'entry');
    const g = await flow('A4', { entry: [e], review: [r], approve: [a] }, 'entry');
    const set = (v: number | null) =>
      db.query(`UPDATE task_definitions SET approval_levels = $1 WHERE code IN ('A2', 'A4') AND workflow_id = (SELECT id FROM workflow_definitions WHERE version = 1)`, [v]);
    try {
      let t = await get(e, f.taskId);
      expect(t.levels_required).toBe(3);
      t = (await act(e, f.taskId, 'submit', t.version)).body.task; // snapshot: 3 levels
      expect(t.levels_required).toBe(3);

      await set(2); // the admin changes the stage to two levels
      const inFlight = await get(r, f.taskId);
      expect(inFlight.levels_required).toBe(3);
      expect(inFlight.approval_path).toHaveLength(3);
      const notSubmitted = await get(e, g.taskId);
      expect(notSubmitted.levels_required).toBe(2);
      expect(notSubmitted.approval_path.map((l: { kind: string }) => l.kind)).toEqual(['entry', 'approve']);

      // the task in flight still goes through review
      t = (await act(r, f.taskId, 'review', inFlight.version)).body.task;
      expect(t.state).toBe('in_approval');
      // a rejection back to entry and a resubmission keep the snapshot
      let rej = await act(a, f.taskId, 'reject', t.version, { note: 'again' });
      rej = await act(r, f.taskId, 'reject', rej.body.task.version, { note: 'again please' });
      expect(rej.body.task.state).toBe('entry');
      const again = await act(e, f.taskId, 'submit', rej.body.task.version);
      expect(again.body.task.state).toBe('in_review');
      expect(again.body.task.levels_required).toBe(3);

      // the not-yet-submitted task takes the new path: entry then approve, no review
      const sub = await act(e, g.taskId, 'submit', notSubmitted.version);
      expect(sub.body.task.state).toBe('in_approval');
      expect(sub.body.task.levels_required).toBe(2);
      expect((await act(r, g.taskId, 'review', sub.body.task.version)).status).toBe(409); // the approve level has no review
    } finally {
      await set(null);
    }
  });
});

describe('a level with no eligible holder (B10)', () => {
  it('goes to the System Admins as "no holder" and is never skipped', async () => {
    const p = await actor(app, db, { level: 'review' });
    const admin = await plainAdmin(app, db);
    // the approve cell names a user who cannot hold it (no assignment): nobody can act
    const nobody = await actor(app, db, { level: 'view', regions: [1] });
    const f = await flow('A1', { entry: [p], review: [p], approve: [nobody] }, 'entry');
    let t = await get(p, f.taskId);
    const res = await act(p, f.taskId, 'submit', t.version);
    t = res.body.task;
    // the review level was skipped (same person), the approve level has no holder: not skipped, waits
    expect(res.body.skipped_levels).toEqual([2]);
    expect(t.state).toBe('in_approval');
    expect(t.ball_in_court.no_eligible_holder).toBe(true);

    const notified = await db.query(`SELECT user_id FROM notifications WHERE task_id = $1 AND kind = 'no_eligible_holder'`, [f.taskId]);
    expect(notified.rowCount).toBeGreaterThan(0);
    expect(notified.rows.map((n) => n.user_id)).toContain(admin.user.id);

    const inbox = await admin.api.call('get', `/approvals?tab=approve&q=${f.site.code}`);
    expect(inbox.status).toBe(200);
    expect(inbox.body.items).toHaveLength(1);
    expect(inbox.body.items[0].task.id).toBe(f.taskId);
    expect(inbox.body.items[0].task.ball_in_court.no_eligible_holder).toBe(true);
    // not in the inbox of anyone else
    expect((await p.api.call('get', `/approvals?q=${f.site.code}`)).body.items).toHaveLength(0);
    // the submitter cannot approve their own task
    await p.api.stepUp(p.user.password);
    expect((await act(p, f.taskId, 'approve', t.version)).status).toBe(403);
    // a System Admin can act on it
    const done = await act(admin, f.taskId, 'approve', t.version);
    expect(done.status).toBe(200);
    expect(done.body.task.state).toBe('approved');
  });
});

describe('group levels', () => {
  it('any one member claims the level; the others cannot act until it is released', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const m1 = await actor(app, db, { level: 'approve' });
    const m2 = await actor(app, db, { level: 'approve' });
    const outsider = await actor(app, db, { level: 'approve' });
    const group = await groupWith(db, [m1.user.id, m2.user.id]);
    const f = await flow('A1', { entry: [e], review: [], approve: [] }, 'in_approval');
    await setCell(db, 'A1', REGION, 'review', { group: [group] });
    await setCell(db, 'A1', REGION, 'approve', { group: [group] });

    let t = await get(m1, f.taskId);
    expect(t.ball_in_court.holders.map((h: { kind: string }) => h.kind)).toEqual(['group']);
    expect(t.allowed_actions.map((x: { action: string }) => x.action)).toContain('claim');
    // both members see it in the inbox, the outsider does not
    for (const m of [m1, m2]) {
      const inbox = await m.api.call('get', `/approvals?q=${f.site.code}`);
      expect(inbox.body.items).toHaveLength(1);
      expect(inbox.body.items[0].via_group.id).toBe(group);
    }
    expect((await outsider.api.call('get', `/approvals?q=${f.site.code}`)).body.items).toHaveLength(0);
    expect((await act(outsider, f.taskId, 'claim', t.version)).status).toBe(403);

    const claimed = await act(m1, f.taskId, 'claim', t.version);
    expect(claimed.status).toBe(200);
    expect(claimed.body.task.ball_in_court.claimed_by.id).toBe(m1.user.id);
    t = claimed.body.task;
    // gone from the other member's inbox, refused when acting, claim refused
    expect((await m2.api.call('get', `/approvals?q=${f.site.code}`)).body.items).toHaveLength(0);
    expect((await m1.api.call('get', `/approvals?q=${f.site.code}`)).body.items).toHaveLength(1);
    const second = await act(m2, f.taskId, 'claim', t.version);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('already_claimed');
    expect(second.body.claimed_by.id).toBe(m1.user.id);
    await m2.api.stepUp(m2.user.password);
    expect((await act(m2, f.taskId, 'approve', t.version)).status).toBe(409);
    // only the claimant releases
    expect((await act(m2, f.taskId, 'release', t.version)).status).toBe(403);
    const rel = await act(m1, f.taskId, 'release', t.version);
    expect(rel.status).toBe(200);
    expect(rel.body.task.ball_in_court.claimed_by).toBeUndefined();
    // now the other member acts directly (the first action claims implicitly and completes the level)
    const done = await act(m2, f.taskId, 'approve', rel.body.task.version);
    expect(done.status).toBe(200);
    expect(done.body.task.state).toBe('approved');
  });

  it('two members claiming at the same moment: one wins, the other gets a conflict that names the claimant', async () => {
    const m1 = await actor(app, db, { level: 'approve' });
    const m2 = await actor(app, db, { level: 'approve' });
    const group = await groupWith(db, [m1.user.id, m2.user.id]);
    const f = await flow('A1', { entry: [m1], review: [m1], approve: [m1] }, 'in_approval');
    await setCell(db, 'A1', REGION, 'approve', { group: [group] });
    const t = await get(m1, f.taskId);
    const [r1, r2] = await Promise.all([act(m1, f.taskId, 'claim', t.version), act(m2, f.taskId, 'claim', t.version)]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0]).toBe(200);
    expect([409, 412]).toContain(statuses[1]);
    const after = await get(m1, f.taskId);
    const winner = r1.status === 200 ? m1 : m2;
    expect(after.ball_in_court.claimed_by.id).toBe(winner.user.id);
    // a later claim with the fresh version names the claimant
    const loser = winner === m1 ? m2 : m1;
    const again = await act(loser, f.taskId, 'claim', after.version);
    expect(again.status).toBe(409);
    expect(again.body.claimed_by).toMatchObject({ id: winner.user.id, display_name: winner.user.name });
  });

  it('under "all members must approve" every member votes; one rejection rejects the task', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const m1 = await actor(app, db, { level: 'review' });
    const m2 = await actor(app, db, { level: 'review' });
    const a = await actor(app, db, { level: 'approve' });
    const group = await groupWith(db, [m1.user.id, m2.user.id]);
    const f = await flow('A1', { entry: [e], review: [], approve: [a] }, 'in_review');
    await setCell(db, 'A1', REGION, 'review', { group: [group] }, 'all_members');
    // the level was opened before the cell existed in this fixture: open the round with its voters the way the engine does
    await db.query(`INSERT INTO task_level_voters (task_id, level, round, user_id) VALUES ($1, 2, 1, $2), ($1, 2, 1, $3)`, [f.taskId, m1.user.id, m2.user.id]);

    let t = await get(m1, f.taskId);
    expect(t.ball_in_court).toMatchObject({ rule: 'all_members', votes_needed: 2, votes_done: 0 });
    expect(t.allowed_actions.map((x: { action: string }) => x.action)).not.toContain('claim');

    const v1 = await act(m1, f.taskId, 'review', t.version);
    expect(v1.status).toBe(200);
    expect(v1.body.votes_missing).toBe(1);
    expect(v1.body.task.state).toBe('in_review');
    expect(v1.body.task.ball_in_court.votes_done).toBe(1);
    // the same member cannot vote twice; the inbox of the first member no longer shows it
    expect((await act(m1, f.taskId, 'review', v1.body.task.version)).status).toBe(409);
    expect((await m1.api.call('get', `/approvals?q=${f.site.code}`)).body.items).toHaveLength(0);
    expect((await m2.api.call('get', `/approvals?q=${f.site.code}`)).body.items).toHaveLength(1);

    const v2 = await act(m2, f.taskId, 'review', v1.body.task.version);
    expect(v2.status).toBe(200);
    expect(v2.body.votes_missing).toBeUndefined();
    expect(v2.body.task.state).toBe('in_approval');

    // one rejection from a member rejects (new task)
    const g = await flow('A1', { entry: [e], review: [], approve: [a] }, 'in_review');
    await setCell(db, 'A1', REGION, 'review', { group: [group] }, 'all_members');
    await db.query(`INSERT INTO task_level_voters (task_id, level, round, user_id) VALUES ($1, 2, 1, $2), ($1, 2, 1, $3)`, [g.taskId, m1.user.id, m2.user.id]);
    t = await get(m2, g.taskId);
    const rej = await act(m2, g.taskId, 'reject', t.version, { note: 'photos missing' });
    expect(rej.status).toBe(200);
    expect(rej.body.task.state).toBe('entry');
    expect(rej.body.task.last_return_note).toBe('photos missing');
  });
});

describe('open snags and comments', () => {
  it('a task cannot be approved while a snag that blocks it is open', async () => {
    const a = await actor(app, db, { level: 'approve' });
    const f = await flow('A1', { entry: [a], review: [a], approve: [a] }, 'in_approval');
    const st = await db.query(`INSERT INTO snag_types (code, name_en) VALUES ($1, 'Test snag') RETURNING id`, [`WFS${Date.now() % 100000}`]);
    const sn = await db.query(
      `INSERT INTO snags (site_id, region_id, task_id, snag_type_id, scope, description, raised_by) VALUES ($1, $2, $3, $4, 'CW', 'crack', $5) RETURNING id`,
      [f.site.id, REGION, f.taskId, st.rows[0].id, a.user.id],
    );
    const t = await get(a, f.taskId);
    const blocked = await act(a, f.taskId, 'approve', t.version);
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('open_snags');
    await db.query(`UPDATE snags SET status = 'closed' WHERE id = $1`, [sn.rows[0].id]);
    expect((await act(a, f.taskId, 'approve', t.version)).status).toBe(200);
  });

  it('comments: add with a mention, list oldest first, and refuse outsiders', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const peer = await actor(app, db, { level: 'view' });
    const elsewhere = await actor(app, db, { level: 'entry', regions: [2] });
    const viewOnly = await actor(app, db, { level: 'view', grants: [['sites', 'view']] });
    const f = await flow('A1', { entry: [e], review: [e], approve: [e] });
    const c1 = await e.api.call('post', `/tasks/${f.taskId}/comments`, { body: 'first', mention_user_ids: [peer.user.id] });
    expect(c1.status).toBe(201);
    expect(c1.body.author.id).toBe(e.user.id);
    expect(c1.body.mentions.map((m: { id: string }) => m.id)).toEqual([peer.user.id]);
    await viewOnly.api.call('post', `/tasks/${f.taskId}/comments`, { body: 'second' });
    const list = await peer.api.call('get', `/tasks/${f.taskId}/comments`);
    expect(list.body.items.map((c: { body: string }) => c.body)).toEqual(['first', 'second']);
    const notif = await db.query(`SELECT kind FROM notifications WHERE user_id = $1 AND task_id = $2`, [peer.user.id, f.taskId]);
    expect(notif.rows.map((n) => n.kind)).toContain('mention');
    expect((await e.api.call('post', `/tasks/${f.taskId}/comments`, { body: '' })).status).toBe(422);
    expect((await elsewhere.api.call('get', `/tasks/${f.taskId}/comments`)).status).toBe(404);
    expect((await elsewhere.api.call('post', `/tasks/${f.taskId}/comments`, { body: 'x' })).status).toBe(404);
    const page = await e.api.call('get', `/tasks/${f.taskId}/comments?limit=1`);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.page.next_cursor).toBeTruthy();
    const page2 = await e.api.call('get', `/tasks/${f.taskId}/comments?limit=1&cursor=${page.body.page.next_cursor}`);
    expect(page2.body.items[0].body).toBe('second');
  });
});

describe('the database is the only writer', () => {
  it('the application role cannot write the workflow tables directly', async () => {
    const { Client } = await import('pg');
    const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    try {
      const e = await actor(app, db, { level: 'entry' });
      const f = await flow('A1', { entry: [e], review: [e], approve: [e] });
      await c.query("SELECT set_config('app.region_ids', '*', false)");
      await expect(c.query(`UPDATE task_instances SET state = 'approved' WHERE id = $1`, [f.taskId])).rejects.toThrow(/permission denied|only through wf_/);
      await expect(c.query(`INSERT INTO workflow_steps (task_id, level, action) VALUES ($1, 1, 'submit')`, [f.taskId])).rejects.toThrow(/permission denied|only through wf_/);
      await expect(c.query(`INSERT INTO comments (task_id, region_id, author_id, body) VALUES ($1, $2, $3, 'x')`, [f.taskId, REGION, e.user.id])).rejects.toThrow(/permission denied|only through wf_/);
      await expect(c.query(`DELETE FROM task_level_actors WHERE task_id = $1`, [f.taskId])).rejects.toThrow(/permission denied/);
      // an engine function called without a signed-in actor does nothing
      await c.query("SELECT set_config('app.user_id', '', false)");
      await expect(c.query(`SELECT wf_start($1, 1, NULL)`, [f.taskId])).rejects.toThrow(/no signed-in actor/);
    } finally {
      await c.end();
    }
  });
});
