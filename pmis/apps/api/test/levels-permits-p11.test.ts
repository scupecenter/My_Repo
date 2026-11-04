import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { adminApi, startApp, superDb } from './helpers';
import { G, PERMIT_CW, patch, post, recPath, regCell } from './reg-helpers';
import { Actor, actor, makeSite, makeTask, setCell } from './wf-helpers';

/**
 * Migration 0054 / work package P11 (owner answers Q215, Q216, Q217, Q220, Q221, Q222 and decision D220b of 2026-11-04).
 * The conversion runs on the sites of each test only (p_sites), like levels-permits.test.ts. Region 7 and the register-cell lock of the other register suites.
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

const R = 7;
const freeze = (id: string): Promise<unknown> => db.query('UPDATE task_instances SET path_frozen_at = now() WHERE id = $1', [id]);
const convert = async (sites: string[], dry = false): Promise<Record<string, any>> =>
  (await q<{ r: Record<string, any> }>(db, 'SELECT levels_convert_two($1, $2::uuid[]) AS r', [dry, sites]))[0]!.r;
const notes = async (user: string, kind: string, link: string): Promise<{ title: string; body: string }[]> =>
  q(db, 'SELECT title, body FROM notifications WHERE user_id = $1 AND kind = $2 AND link LIKE $3 ORDER BY created_at', [user, kind, `%${link}`]);
const conv = async (id: string) => (await q<Record<string, any>>(db, 'SELECT * FROM levels_conversions WHERE entity_id = $1', [id]))[0];

describe('Q215 / Q216: a converted 3-level item tells the old reviewer and the entry person once, and its old acts are labelled', () => {
  async function fixture() {
    const entry = await actor(app, db, { level: 'entry' });
    const review = await actor(app, db, { level: 'review' });
    const approve = await actor(app, db, { level: 'approve', stepUp: true });
    const site = await makeSite(db, R, { prefix: 'P11' });
    const atReview = await makeTask(db, site, 'A1', 'in_review', { actualDate: '2026-01-05' });
    const atApprove = await makeTask(db, site, 'A2', 'in_approval', { actualDate: '2026-01-05' });
    const closed = await makeTask(db, site, 'A4', 'approved', { level: 3, actualDate: '2026-01-05' });
    for (const id of [atReview, atApprove, closed]) await freeze(id);
    for (const c of ['A1', 'A2', 'A4']) {
      await setCell(db, c, R, 'entry', { user: [entry.user.id] });
      await setCell(db, c, R, 'review', { user: [review.user.id] });
      await setCell(db, c, R, 'approve', { user: [approve.user.id] });
    }
    await db.query('UPDATE task_instances SET ball_in_court_user_id = $2 WHERE id = $1', [atReview, review.user.id]);
    await db.query(`INSERT INTO task_level_actors (task_id, level, user_id, how) VALUES ($1, 1, $2, 'acted'), ($1, 2, $3, 'acted')`, [atApprove, entry.user.id, review.user.id]);
    // the old path of the level-3 item: entry submitted, the reviewer passed it (written before the conversion)
    await db.query(`INSERT INTO workflow_steps (task_id, level, action, acted_by, created_at) VALUES ($1, 1, 'submit', $2, now() - interval '2 days'), ($1, 2, 'review', $3, now() - interval '1 day')`,
      [atApprove, entry.user.id, review.user.id]);
    return { site: site.id, entry, review, approve, atReview, atApprove, closed };
  }

  it('sends one levels_converted notice to the old reviewer and to the entry person, naming who is asked now, and never again', async () => {
    const f = await fixture();
    const r = await convert([f.site]);
    expect(r).toMatchObject({ tasks: 2, people_told: expect.any(Number) });
    for (const id of [f.atReview, f.atApprove]) {
      const c = await conv(id);
      expect(c).toMatchObject({ entity_type: 'task', levels_before: 3, migration: '0054', reason: 'owner decision: two levels', held: false });
      expect(c!.notified_at).not.toBeNull();
      expect(c!.old_path.levels_required).toBe(3);
    }
    // the reviewer was pinned to the review item and acted on the level-3 item; the entry person entered the level-3 item
    const rv = await notes(f.review.user.id, 'levels_converted', f.atReview);
    expect(rv).toHaveLength(1);
    expect(rv[0]!.title).toBe('Approval path changed to two levels');
    expect(rv[0]!.body).toContain('previous path before conversion');
    expect(rv[0]!.body).toContain(`It now waits for L2 (Data Reviewer & Approver): ${f.approve.user.name}`);
    expect(await notes(f.review.user.id, 'levels_converted', f.atApprove)).toHaveLength(1);
    expect(await notes(f.entry.user.id, 'levels_converted', f.atApprove)).toHaveLength(1);
    // the closed item is not touched and nobody hears about it
    expect(await conv(f.closed)).toBeUndefined();
    // once: a second run and a second notify send nothing
    await convert([f.site]);
    expect((await q<{ n: number }>(db, `SELECT levels_conversion_notify('task', $1) AS n`, [f.atApprove]))[0]!.n).toBe(0);
    expect(await notes(f.review.user.id, 'levels_converted', f.atApprove)).toHaveLength(1);
  });

  it('labels the old review acts "previous path" in the task history; later acts are not labelled', async () => {
    const f = await fixture();
    await convert([f.site]);
    await db.query(`INSERT INTO workflow_steps (task_id, level, action, acted_by, created_at) VALUES ($1, 2, 'reject', $2, now() + interval '1 second')`, [f.atApprove, f.approve.user.id]);
    const h = await f.approve.api.call('get', `/tasks/${f.atApprove}/history`);
    expect(h.status).toBe(200);
    const items = h.body.items as { level: number; action: string; previous_path: boolean }[];
    expect(items.map((x) => [x.action, x.level, x.previous_path])).toEqual([['submit', 1, false], ['review', 2, true], ['reject', 2, false]]);
  });

  it('notifies and labels a converted register record the same way, and an item converted by 0050 is told once by the backfill path', async () => {
    const f = await fixture();
    const rec = (await q<{ id: string }>(db,
      `INSERT INTO register_records (entity_id, register_key, site_id, region_id, state, current_level, levels_required, path_frozen_at, level_round, data, created_by)
       VALUES (gen_random_uuid(), 'meetings', $1, $2, 'in_approval', 3, 3, now(), 1, '{}', $3) RETURNING id`, [f.site, R, f.entry.user.id]))[0]!.id;
    await db.query(`INSERT INTO register_steps (record_id, level, action, acted_by, created_at) VALUES ($1, 2, 'review', $2, now() - interval '1 hour')`, [rec, f.review.user.id]);
    await db.query(`INSERT INTO register_level_actors (record_id, level, user_id, how) VALUES ($1, 2, $2, 'acted')`, [rec, f.review.user.id]);
    await convert([f.site]);
    expect(await notes(f.entry.user.id, 'levels_converted', rec)).toHaveLength(1);    // the creator
    expect(await notes(f.review.user.id, 'levels_converted', rec)).toHaveLength(1);   // the dropped reviewer
    const { api } = await adminApi(app, db);
    const h = await api.call('get', recPath('meetings', rec, '/history'));
    expect(h.status).toBe(200);
    expect(h.body.items.map((x: { previous_path: boolean }) => x.previous_path)).toEqual([true]);

    // a conversion record as 0050 left it (filled in from its audit row by the migration): the notice goes out once
    const old = await makeTask(db, (await makeSite(db, R, { prefix: 'P11' })), 'A3', 'in_approval', { level: 2, levels: 2, actualDate: '2026-01-05' });
    await setCell(db, 'A3', R, 'approve', { user: [f.approve.user.id] });
    await db.query(`INSERT INTO levels_conversions (entity_type, entity_id, converted_at, levels_before, migration, reason, old_path, people)
                    VALUES ('task', $1, now(), 3, '0050', 'owner decision: two levels', '{"state": "in_review"}', jsonb_build_object('old_reviewers', jsonb_build_array($2::text), 'entry_people', '[]'::jsonb))`,
      [old, f.review.user.id]);
    expect((await q<{ n: number }>(db, `SELECT levels_conversion_notify('task', $1) AS n`, [old]))[0]!.n).toBe(1);
    expect((await q<{ n: number }>(db, `SELECT levels_conversion_notify('task', $1) AS n`, [old]))[0]!.n).toBe(0);
    expect(await notes(f.review.user.id, 'levels_converted', old)).toHaveLength(1);
  });
});

describe('Q217: open items on one level are converted to L1 / L2 after an impact report; without an L2 holder they are held', () => {
  async function oneLevel(withL2: boolean) {
    const entry = await actor(app, db, { level: 'entry' });
    const approve = await actor(app, db, { level: 'approve', stepUp: true });
    const site = await makeSite(db, R, { prefix: 'P11' });
    const id = await makeTask(db, site, 'A1', 'entry', { level: 1, levels: 1, actualDate: '2026-01-05' });
    await db.query(`UPDATE task_instances SET actual_start = '2026-01-02' WHERE id = $1`, [id]);
    await freeze(id);
    await setCell(db, 'A1', R, 'entry', { user: [entry.user.id] });
    await setCell(db, 'A1', R, 'approve', withL2 ? { user: [approve.user.id] } : {});
    return { site: site.id, id, entry, approve };
  }
  const task = async (id: string) => (await q<Record<string, any>>(db, 'SELECT state::text AS state, levels_required, current_level, version FROM task_instances WHERE id = $1', [id]))[0]!;

  it('lists the item in the dry run, then converts it: the entry person is told, the submission goes to L2 and is no self-approval', async () => {
    const f = await oneLevel(true);
    const dry = await convert([f.site], true);
    expect(dry).toMatchObject({ dry_run: true, one_level_tasks: 1, one_level_tasks_held: 0 });
    expect(dry.one_level_items).toEqual([expect.objectContaining({ entity_type: 'task', id: f.id, l2_holder: true })]);
    expect((await task(f.id)).levels_required).toBe(1);   // a dry run writes nothing
    expect(await convert([f.site])).toMatchObject({ one_level_tasks: 1, one_level_tasks_held: 0 });
    expect(await task(f.id)).toMatchObject({ levels_required: 2, state: 'entry' });
    expect(await conv(f.id)).toMatchObject({ levels_before: 1, held: false, migration: '0054' });
    const n = await notes(f.entry.user.id, 'levels_converted', f.id);
    expect(n).toHaveLength(1);
    expect(n[0]!.body).toContain('this item had one level (self-approval)');
    const audit = await q<{ reason: string }>(db, `SELECT reason FROM audit_log WHERE action = 'levels_converted_two' AND entity_id = $1`, [f.id]);
    expect(audit.map((a) => a.reason)).toEqual(['owner decision: two levels (Q217, item on a one-level snapshot)']);
    const t = await task(f.id);
    const sub = await f.entry.api.call('post', `/tasks/${f.id}/submit`, {}, { 'If-Match': `"${t.version}"` });
    expect(sub.status).toBe(200);
    expect(sub.body.task.state).toBe('in_approval');
  });

  it('holds an item without an L2 holder: the admins are alerted, submit is refused with empty_cell, and the hold is released once the Matrix names L2', async () => {
    const f = await oneLevel(false);
    expect(await convert([f.site])).toMatchObject({ one_level_tasks: 1, one_level_tasks_held: 1 });
    expect(await conv(f.id)).toMatchObject({ held: true, hold_released_at: null });
    const alerts = await q(db, `SELECT 1 FROM notifications WHERE kind = 'no_eligible_holder' AND task_id = $1 AND title LIKE 'Set an L2 holder%'`, [f.id]);
    expect(alerts.length).toBeGreaterThan(0);
    expect((await notes(f.entry.user.id, 'levels_converted', f.id))[0]!.body).toContain('It is held until the Responsibility Matrix names an L2 holder');
    let t = await task(f.id);
    const refused = await f.entry.api.call('post', `/tasks/${f.id}/submit`, {}, { 'If-Match': `"${t.version}"` });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('empty_cell');
    expect((await task(f.id)).state).toBe('entry');
    await setCell(db, 'A1', R, 'approve', { user: [f.approve.user.id] });
    t = await task(f.id);
    const ok = await f.entry.api.call('post', `/tasks/${f.id}/submit`, {}, { 'If-Match': `"${t.version}"` });
    expect(ok.status).toBe(200);
    expect(ok.body.task.state).toBe('in_approval');
    expect((await conv(f.id))!.hold_released_at).not.toBeNull();
    expect(await q(db, `SELECT 1 FROM audit_log WHERE action = 'levels_hold_released' AND entity_id = $1`, [f.id])).toHaveLength(1);
  });

  it('converts a register record on one level the same way', async () => {
    const f = await oneLevel(true);
    const rec = (await q<{ id: string }>(db,
      `INSERT INTO register_records (entity_id, register_key, site_id, region_id, state, current_level, levels_required, path_frozen_at, level_round, data, created_by)
       VALUES (gen_random_uuid(), 'meetings', $1, $2, 'entry', 1, 1, now(), 1, '{}', $3) RETURNING id`, [f.site, R, f.entry.user.id]))[0]!.id;
    expect(await convert([f.site])).toMatchObject({ one_level_records: 1 });
    expect((await q(db, 'SELECT levels_required, state FROM register_records WHERE id = $1', [rec]))[0]).toEqual({ levels_required: 2, state: 'entry' });
    expect(await conv(rec)).toMatchObject({ entity_type: 'register_record', levels_before: 1 });
    expect(await notes(f.entry.user.id, 'levels_converted', rec)).toHaveLength(1);
  });
});

describe('Q220 / D220b / Q221 / Q222: permits per stream', () => {
  /** L1 and L2 holders of each stream row in region R, and a site. */
  async function streams() {
    const mk = (level: 'entry' | 'approve') => actor(app, db, { level, grants: G('permits_hse', 'view', 'create', 'edit', 'approve'), regions: [R], modules: null });
    const rows = { CW: 'permits_hse', TE: 'permits_hse_te', ACQ: 'permits_hse_acq', OM: 'permits_hse_om' } as const;
    const out: Record<string, { entry: Actor; lead: Actor }> = {};
    for (const [s, row] of Object.entries(rows)) {
      const entry = await mk('entry');
      const lead = await mk('approve');
      await regCell(db, row, R, 'entry', { user: [entry.user.id] });
      await regCell(db, row, R, 'approve', { user: [lead.user.id] });
      out[s] = { entry, lead };
    }
    const site = await makeSite(db, R, { prefix: 'P11' });
    return { ...out, site } as unknown as { CW: { entry: Actor; lead: Actor }; TE: { entry: Actor; lead: Actor }; ACQ: { entry: Actor; lead: Actor }; OM: { entry: Actor; lead: Actor }; site: { id: string } };
  }
  const DIS = { permit_type: 'Access - Dismantle', status: 'Applied', has_expiry: true };
  const create = (a: Actor, site: string, data: Record<string, unknown>) => a.api.call('post', recPath('permits_hse'), { site_id: site, data });
  const holdersAfterSubmit = async (a: Actor, body: Record<string, any>) => {
    const sub = await post(a.api, 'permits_hse', body.id, 'submit', body.version);
    expect(sub.status).toBe(200);
    return sub.body.ball_in_court.holders.map((h: { ref_id: string }) => h.ref_id);
  };

  it('the stream of a purpose-based type is required and chosen by the person entering it; it decides the Matrix row and the L2 (D220b)', async () => {
    const s = await streams();
    const none = await create(s.CW.entry, s.site.id, DIS);
    expect(none.status).toBe(422);
    expect(none.body.errors[0]).toMatchObject({ path: '/data/permit_stream', code: 'stream_required' });
    const wrong = await create(s.CW.entry, s.site.id, { ...DIS, permit_stream: 'OM' });
    expect(wrong.body.errors[0]).toMatchObject({ code: 'stream_not_allowed' });
    const fixed = await create(s.CW.entry, s.site.id, { ...PERMIT_CW, permit_stream: 'TE' });
    expect(fixed.body.errors[0]).toMatchObject({ code: 'stream_fixed' });
    // the CW engineer may not enter it on the TE stream; the TE engineer may, and the TE lead approves
    expect((await create(s.CW.entry, s.site.id, { ...DIS, permit_stream: 'TE' })).status).toBe(403);
    const te = await create(s.TE.entry, s.site.id, { ...DIS, permit_stream: 'TE' });
    expect(te.status).toBe(201);
    expect(await holdersAfterSubmit(s.TE.entry, te.body)).toEqual([s.TE.lead.user.id]);
    const cw = await create(s.CW.entry, s.site.id, { ...DIS, permit_stream: 'CW' });
    expect(cw.status).toBe(201);
    expect(await holdersAfterSubmit(s.CW.entry, cw.body)).toEqual([s.CW.lead.user.id]);
    // QC / Maintenance on O&M, Survey on RF & Design, City Council on Acquisition (fixed)
    const om = await create(s.OM.entry, s.site.id, { permit_type: 'Access - QC / Maintenance', permit_stream: 'OM', status: 'Applied' });
    expect(om.status).toBe(201);
    expect(await holdersAfterSubmit(s.OM.entry, om.body)).toEqual([s.OM.lead.user.id]);
    const sv = await create(s.ACQ.entry, s.site.id, { permit_type: 'Access - Survey', permit_stream: 'ACQ', status: 'Applied' });
    expect(sv.status).toBe(201);
    expect(await holdersAfterSubmit(s.ACQ.entry, sv.body)).toEqual([s.ACQ.lead.user.id]);
    expect((await create(s.CW.entry, s.site.id, { permit_type: 'City Council Permit', status: 'Applied' })).status).toBe(403);
    const cc = await create(s.ACQ.entry, s.site.id, { permit_type: 'City Council Permit', status: 'Applied' });
    expect(cc.status).toBe(201);
    expect(await holdersAfterSubmit(s.ACQ.entry, cc.body)).toEqual([s.ACQ.lead.user.id]);
  });

  it('a draft entered before the stream choice opens a new version, and the stream must be chosen before submit (Q221 recheck at submit)', async () => {
    const s = await streams();
    // a draft of a purpose-based type without a stream (as before 0054), held by the CW engineer
    const id = (await q<{ id: string }>(db,
      `INSERT INTO register_records (entity_id, register_key, site_id, region_id, state, current_level, levels_required, level_round, data, created_by)
       VALUES (gen_random_uuid(), 'permits_hse', $1, $2, 'entry', 1, 2, 0, $3, $4) RETURNING id`, [s.site.id, R, JSON.stringify(DIS), s.CW.entry.user.id]))[0]!.id;
    const sub = await post(s.CW.entry.api, 'permits_hse', id, 'submit', 1);
    expect(sub.status).toBe(422);
    expect(sub.body.errors[0]).toMatchObject({ code: 'stream_required' });
    const ok = await patch(s.CW.entry.api, 'permits_hse', id, 1, { data: { permit_stream: 'CW' } });
    expect(ok.status).toBe(200);
    expect((await post(s.CW.entry.api, 'permits_hse', id, 'submit', ok.body.version)).status).toBe(200);
  });

  it('rechecks every save and submit; a draft whose holder lost the row is transferred to the qualified holder with a notice (Q221)', async () => {
    const s = await streams();
    const d = await create(s.CW.entry, s.site.id, { ...DIS, permit_stream: 'CW' });
    expect(d.status).toBe(201);
    // the Matrix changes: the CW row's L1 is now somebody else (two holders, so the draft stays pinned to the old one)
    const newer = await actor(app, db, { level: 'entry', grants: G('permits_hse', 'view', 'create', 'edit'), regions: [R], modules: null });
    await regCell(db, 'permits_hse', R, 'entry', { user: [newer.user.id] });
    await db.query('UPDATE register_records SET ball_in_court_user_id = $2 WHERE id = $1', [d.body.id, s.CW.entry.user.id]);
    const v = (await q<{ version: number }>(db, 'SELECT version FROM register_records WHERE id = $1', [d.body.id]))[0]!.version;
    const save = await patch(s.CW.entry.api, 'permits_hse', d.body.id, v, { data: { applied_date: '2026-01-05' } });
    expect(save.status).toBe(403);
    expect(save.body.code).toBe('not_eligible_holder');
    expect((await post(s.CW.entry.api, 'permits_hse', d.body.id, 'submit', v)).status).toBe(403);
    // the old holder sees the transfer action (not edit / submit), the new holder too (the draft is pinned to somebody who no longer qualifies)
    const mine = await s.CW.entry.api.call('get', recPath('permits_hse', d.body.id));
    expect(mine.body.allowed_actions).toContain('transfer');
    expect(mine.body.allowed_actions).not.toContain('submit');
    const theirs = await newer.api.call('get', recPath('permits_hse', d.body.id));
    expect(theirs.body.allowed_actions).toContain('transfer');
    // the dry-run recheck lists it
    const dry = (await q<{ r: { record_ids: string[] } }>(db, 'SELECT permit_drafts_recheck(true) AS r'))[0]!.r;
    expect(dry.record_ids).toContain(d.body.id);
    // a stranger cannot move it; the old holder hands it over
    expect((await post(s.TE.entry.api, 'permits_hse', d.body.id, 'transfer', v, {})).status).toBe(403);
    const tr = await post(s.CW.entry.api, 'permits_hse', d.body.id, 'transfer', v, { note: 'I moved to TE' });
    expect(tr.status).toBe(200);
    expect((await q<{ pin: string }>(db, 'SELECT ball_in_court_user_id AS pin FROM register_records WHERE id = $1', [d.body.id]))[0]!.pin).toBe(newer.user.id);
    expect(await notes(newer.user.id, 'permit_transferred', d.body.id)).toHaveLength(1);
    expect(await notes(s.CW.entry.user.id, 'permit_transferred', d.body.id)).toHaveLength(0);   // the old holder made the move: not told about their own act
    const step = await q<{ action: string; note: string }>(db, `SELECT action, note FROM register_steps WHERE record_id = $1 AND action = 'transfer'`, [d.body.id]);
    expect(step).toEqual([{ action: 'transfer', note: 'I moved to TE' }]);
    const audit = await q<{ actor_id: string }>(db, `SELECT actor_id FROM audit_log WHERE action = 'register_record_transfer' AND entity_id = $1`, [d.body.id]);
    expect(audit).toEqual([{ actor_id: s.CW.entry.user.id }]);
    // the data is kept and the new holder carries on
    const after = await newer.api.call('get', recPath('permits_hse', d.body.id));
    expect(after.body.data).toMatchObject({ permit_type: 'Access - Dismantle', permit_stream: 'CW' });
    expect(after.body.allowed_actions).toEqual(expect.arrayContaining(['edit', 'submit']));
    expect((await post(newer.api, 'permits_hse', d.body.id, 'submit', after.body.version)).status).toBe(200);
  });

  it('a qualified holder takes over a draft pinned to somebody who lost the row, and that person is told (Q221)', async () => {
    const s = await streams();
    const d = await create(s.CW.entry, s.site.id, { ...DIS, permit_stream: 'CW' });
    const newer = await actor(app, db, { level: 'entry', grants: G('permits_hse', 'view', 'create', 'edit'), regions: [R], modules: null });
    const other = await actor(app, db, { level: 'entry', grants: G('permits_hse', 'view', 'create', 'edit'), regions: [R], modules: null });
    await regCell(db, 'permits_hse', R, 'entry', { user: [newer.user.id, other.user.id] });
    await db.query('UPDATE register_records SET ball_in_court_user_id = $2 WHERE id = $1', [d.body.id, s.CW.entry.user.id]);
    const v = (await q<{ version: number }>(db, 'SELECT version FROM register_records WHERE id = $1', [d.body.id]))[0]!.version;
    const tr = await post(newer.api, 'permits_hse', d.body.id, 'transfer', v, {});
    expect(tr.status).toBe(200);
    expect((await q<{ pin: string }>(db, 'SELECT ball_in_court_user_id AS pin FROM register_records WHERE id = $1', [d.body.id]))[0]!.pin).toBe(newer.user.id);
    expect(await notes(s.CW.entry.user.id, 'permit_transferred', d.body.id)).toHaveLength(1);
    expect(await notes(other.user.id, 'permit_transferred', d.body.id)).toHaveLength(1);
    // nothing left to transfer now
    expect((await post(other.api, 'permits_hse', d.body.id, 'transfer', tr.body.version, {})).status).toBe(409);
  });

  it('the catalogue lists the permit types the caller may enter, with the streams they may choose (Q222)', async () => {
    const s = await streams();
    const cat = async (a: Actor) => {
      const res = await a.api.call('get', '/registers');
      expect(res.status).toBe(200);
      return res.body.items.find((d: { register_key: string }) => d.register_key === 'permits_hse');
    };
    const cw = await cat(s.CW.entry);
    const byCode = (d: { entry_permit_types: { code: string; streams: string[] }[] }) => Object.fromEntries(d.entry_permit_types.map((t) => [t.code, t.streams]));
    const c = byCode(cw);
    expect(c['Access - CW']).toEqual(['CW']);
    expect(c['Access - Dismantle']).toEqual(['CW']);
    expect(c['Access - Survey']).toEqual(['CW']);
    expect(c['Access - TE']).toBeUndefined();
    expect(c['City Council Permit']).toBeUndefined();
    expect(cw.entry_permit_types.find((t: { code: string }) => t.code === 'PTW - Dismantle')).toEqual({ code: 'PTW - Dismantle', stream: null, choose_stream: true, streams: ['CW'] });
    const om = byCode(await cat(s.OM.entry));
    expect(Object.keys(om).sort()).toEqual(['Access - QC / Maintenance', 'Other Permit', 'Security Clearance']);
    const acq = byCode(await cat(s.ACQ.entry));
    expect(acq['City Council Permit']).toEqual(['ACQ']);
    expect(acq['Access - Survey']).toEqual(['ACQ']);
    // the stream field and its labels
    const f = cw.fields.find((x: { code: string }) => x.code === 'permit_stream');
    expect(f.options).toEqual([
      { value: 'CW', label_en: 'Civil Works (CW)', label_ar: 'الأعمال المدنية (CW)' }, { value: 'TE', label_en: 'Installation (TE)', label_ar: 'التركيب (TE)' },
      { value: 'ACQ', label_en: 'Acquisition / RF & Design', label_ar: 'الاستحواذ / التصميم' }, { value: 'OM', label_en: 'O&M', label_ar: 'التشغيل والصيانة' }]);
  });
});
