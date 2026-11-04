import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { startApp, superDb } from './helpers';
import { G, PERMIT_CW, patch, recPath, regCell } from './reg-helpers';
import { Actor, actor, makeSite, makeTask, setCell } from './wf-helpers';

/**
 * Migration 0050 (owner decisions 2026-11-02):
 *   1. Old 3-level paths become L1 / L2: the old final approver is L2, the old review level is dropped (levels_convert_two).
 *   2. Permits & HSE per stream: CW permits by the CW team, TE permits by the TE team, L2 = the Team Lead of the same stream (Q90), through the Matrix
 *      rows `permits_hse` (covers CW) and `permits_hse_te`.
 * The conversion is run on the sites of each test only (p_sites), so the other suites' 3-level fixtures are not touched. Region 7 and the register-cell lock
 * of the other register suites; no date or weekday dependence.
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
const REASON = 'owner decision: two levels';

interface Item { id: string; version: number; state: string; current_level: number; levels_required: number; ball_in_court_user_id: string | null; level_round: number }
const task = async (id: string): Promise<Item> => (await q<Item>(db, 'SELECT id, version, state::text AS state, current_level, levels_required, ball_in_court_user_id, level_round FROM task_instances WHERE id = $1', [id]))[0]!;
const freeze = (id: string): Promise<unknown> => db.query('UPDATE task_instances SET path_frozen_at = now() WHERE id = $1', [id]);

interface Fixture { site: string; review: Actor; approve: Actor; entry: Actor; atReview: string; atApprove: string; atEntry: string; approved: string; vote: string }

/** Four 3-level tasks on one fresh site: waiting at level 2 (review), at level 3 (approve), back at level 1 after a rejection, and already approved. A fifth is an all_members approve. */
async function fixture(): Promise<Fixture> {
  const entry = await actor(app, db, { level: 'entry' });
  const review = await actor(app, db, { level: 'review' });
  const approve = await actor(app, db, { level: 'approve', stepUp: true });
  const site = await makeSite(db, R, { prefix: 'LV' });
  const codes = ['A1', 'A2', 'A3', 'A4', 'A5'];
  const [atReview, atApprove, atEntry, approved, vote] = [
    await makeTask(db, site, 'A1', 'in_review', { actualDate: '2026-01-05' }),
    await makeTask(db, site, 'A2', 'in_approval', { actualDate: '2026-01-05' }),
    await makeTask(db, site, 'A3', 'entry', { actualDate: '2026-01-05' }),
    await makeTask(db, site, 'A4', 'approved', { level: 3, actualDate: '2026-01-05' }),
    await makeTask(db, site, 'A5', 'in_review', { actualDate: '2026-01-05' }),
  ];
  for (const id of [atReview, atApprove, atEntry, approved, vote]) await freeze(id);
  for (const c of codes) {
    await setCell(db, c, R, 'entry', { user: [entry.user.id] });
    await setCell(db, c, R, 'review', { user: [review.user.id] });
    await setCell(db, c, R, 'approve', { user: [approve.user.id] }, c === 'A5' ? 'all_members' : 'any_one');
  }
  // the reviewer is pinned to the review item, acted at level 2 on the item now at level 3, and has voted on the all_members review
  await db.query('UPDATE task_instances SET ball_in_court_user_id = $2 WHERE id = $1', [atReview, review.user.id]);
  await db.query(`INSERT INTO task_level_actors (task_id, level, user_id, how) VALUES ($1, 1, $2, 'acted'), ($1, 2, $3, 'acted')`, [atApprove, entry.user.id, review.user.id]);
  await db.query('INSERT INTO task_level_voters (task_id, level, round, user_id) VALUES ($1, 2, 1, $2)', [vote, review.user.id]);
  return { site: site.id, review, approve, entry, atReview, atApprove, atEntry, approved, vote };
}

const convert = async (sites: string[], dry = false): Promise<Record<string, number | boolean>> =>
  (await q<{ r: Record<string, number | boolean> }>(db, 'SELECT levels_convert_two($1, $2::uuid[]) AS r', [dry, sites]))[0]!.r;

describe('old 3-level items become L1 / L2 (the old final approver is L2)', () => {
  it('counts first (dry run), then converts the item at level 2, at level 3 and at level 1, and never touches the approved one', async () => {
    const f = await fixture();
    const approvedBefore = await task(f.approved);
    expect(await convert([f.site], true)).toMatchObject({ dry_run: true, tasks: 4, tasks_at_l1: 1, tasks_from_review: 2, tasks_at_approve: 1, records: 0 });
    expect((await task(f.atReview)).levels_required).toBe(3); // a dry run writes nothing

    expect(await convert([f.site])).toMatchObject({ tasks: 4, tasks_from_review: 2, tasks_at_approve: 1, tasks_at_l1: 1 });

    // waiting at level 2 (review) -> L2 (approval); the review pin is gone (the reviewer does not hold L2)
    const a = await task(f.atReview);
    expect(a).toMatchObject({ state: 'in_approval', current_level: 2, levels_required: 2, ball_in_court_user_id: null });
    // at level 3 -> stays at L2; the actor of the dropped review level is out of the snapshot, the entry actor stays
    const b = await task(f.atApprove);
    expect(b).toMatchObject({ state: 'in_approval', current_level: 2, levels_required: 2 });
    expect((await q(db, 'SELECT level FROM task_level_actors WHERE task_id = $1 ORDER BY level', [f.atApprove])).map((x) => x.level)).toEqual([1]);
    // back at level 1 -> still L1
    expect(await task(f.atEntry)).toMatchObject({ state: 'entry', current_level: 1, levels_required: 2 });
    // all_members: the review votes are replaced by one vote per L2 holder, in a new round
    const v = await task(f.vote);
    expect(v).toMatchObject({ state: 'in_approval', current_level: 2, levels_required: 2, level_round: 2 });
    expect((await q(db, 'SELECT level, round, user_id FROM task_level_voters WHERE task_id = $1 ORDER BY user_id', [f.vote]))).toEqual([{ level: 2, round: 2, user_id: f.approve.user.id }]);
    // approved: untouched, byte for byte (same version, still on its 3-level snapshot)
    expect(await task(f.approved)).toEqual(approvedBefore);
    expect((await task(f.approved)).levels_required).toBe(3);
  });

  it('writes one audit row per converted item with before and after and the reason, and none for the approved one', async () => {
    const f = await fixture();
    await convert([f.site]);
    const rows = await q<{ entity_id: string; reason: string; before: Record<string, any>; after: Record<string, any>; action: string }>(db,
      `SELECT entity_id, reason, before, after, action FROM audit_log WHERE action = 'levels_converted_two' AND entity_type = 'task' AND site_id = $1 ORDER BY entity_id`, [f.site]);
    expect(rows.map((r) => r.entity_id).sort()).toEqual([f.atReview, f.atApprove, f.atEntry, f.vote].sort());
    for (const r of rows) {
      expect(r.reason).toBe(REASON);
      expect(r.before.levels_required).toBe(3);
      expect(r.after.levels_required).toBe(2);
    }
    const rev = rows.find((r) => r.entity_id === f.atReview)!;
    expect(rev.before).toMatchObject({ state: 'in_review', current_level: 2, pinned_to: f.review.user.id });
    expect(rev.after).toMatchObject({ state: 'in_approval', current_level: 2, pinned_to: null });
    const lvl3 = rows.find((r) => r.entity_id === f.atApprove)!;
    expect(lvl3.before.dropped.level_actors).toEqual([{ level: 2, user_id: f.review.user.id, how: 'acted' }]); // the dropped acts stay readable in the audit row
    expect((await q(db, `SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'levels_converted_two'`, [f.approved])).length).toBe(0);
    // the history of the workflow steps is untouched
    expect(Number((await q<{ n: string }>(db, 'SELECT count(*) AS n FROM workflow_steps WHERE task_id = ANY($1::uuid[])', [[f.atReview, f.atApprove]]))[0]!.n)).toBe(0);
  });

  it('is idempotent: a second run converts nothing and writes nothing', async () => {
    const f = await fixture();
    await convert([f.site]);
    const audits = async () => Number((await q<{ n: string }>(db, `SELECT count(*) AS n FROM audit_log WHERE action = 'levels_converted_two' AND site_id = $1`, [f.site]))[0]!.n);
    const n1 = await audits();
    const versions = (await q(db, 'SELECT id, version FROM task_instances WHERE site_id = $1 ORDER BY id', [f.site]));
    expect(await convert([f.site])).toMatchObject({ tasks: 0, records: 0 });
    expect(await audits()).toBe(n1);
    expect(await q(db, 'SELECT id, version FROM task_instances WHERE site_id = $1 ORDER BY id', [f.site])).toEqual(versions);
  });

  it('after the conversion the old final approver approves at L2, and the old reviewer no longer can', async () => {
    const f = await fixture();
    await convert([f.site]);
    const t = await task(f.atReview);
    const call = (a: Actor, verb: string, version: number) => a.api.call('post', `/tasks/${f.atReview}/${verb}`, {}, { 'If-Match': `"${version}"` });
    const view = (await f.approve.api.call('get', `/tasks/${f.atReview}`)).body;
    expect(view).toMatchObject({ state: 'in_approval', levels_required: 2 });
    expect(view.ball_in_court).toMatchObject({ level_kind: 'approve', level_code: 'L2' });
    expect((await call(f.review, 'approve', t.version)).status).toBe(403);
    expect((await f.approve.api.stepUp(f.approve.user.password)).status).toBe(200);
    const ok = await call(f.approve, 'approve', t.version);
    expect(ok.status).toBe(200);
    expect(ok.body.task.state).toBe('approved');
    // a stale screen (the version before the conversion) is refused
    expect((await call(f.approve, 'approve', t.version - 1)).status).toBe(412);
  });

  it('converts register records the same way (review -> L2, level 3 stays, approved untouched) and retires cell level 2', async () => {
    const f = await fixture();
    const mk = async (state: string, level: number): Promise<string> => (await q<{ id: string }>(db,
      `INSERT INTO register_records (entity_id, register_key, site_id, region_id, state, current_level, levels_required, path_frozen_at, level_round, data)
       VALUES (gen_random_uuid(), 'meetings', $1, $2, $3, $4, 3, now(), 1, '{}') RETURNING id`, [f.site, R, state, level]))[0]!.id;
    const rv = await mk('in_review', 2);
    const ap = await mk('in_approval', 3);
    const done = await mk('approved', 3);
    expect(await convert([f.site], true)).toMatchObject({ records: 2, records_from_review: 1, records_at_approve: 1 });
    await convert([f.site]);
    const rec = async (id: string) => (await q(db, 'SELECT state, current_level, levels_required FROM register_records WHERE id = $1', [id]))[0];
    expect(await rec(rv)).toEqual({ state: 'in_approval', current_level: 2, levels_required: 2 });
    expect(await rec(ap)).toEqual({ state: 'in_approval', current_level: 2, levels_required: 2 });
    expect(await rec(done)).toEqual({ state: 'approved', current_level: 3, levels_required: 3 });
    expect((await q(db, `SELECT 1 FROM audit_log WHERE action = 'levels_converted_two' AND entity_type = 'register_record' AND entity_id = ANY($1::text[])`, [[rv, ap]])).length).toBe(2);
    expect((await q(db, `SELECT 1 FROM audit_log WHERE entity_id = $1`, [done])).filter((x) => x).length).toBe(0);
    // a record the same function converts for a task-less register keeps its history rows
    expect(Number((await q<{ n: string }>(db, 'SELECT count(*) AS n FROM register_steps WHERE record_id = ANY($1::uuid[])', [[rv, ap]]))[0]!.n)).toBe(0);
  });

  it('every level-2 cell is retired (data kept), and a new level-2 cell is retired on insert', async () => {
    const f = await fixture();
    const n = Number((await q<{ n: string }>(db, 'SELECT count(*) AS n FROM matrix_cells WHERE level = 2'))[0]!.n);
    expect(n).toBeGreaterThan(0);
    // retired by the migration's own run and, for cells made later (the fixtures of every suite), on insert; a full run is not made here (it would convert other suites' fixtures)
    await convert([f.site]);
    expect(Number((await q<{ n: string }>(db, 'SELECT count(*) AS n FROM matrix_cells WHERE level = 2 AND retired_at IS NULL'))[0]!.n)).toBe(0);
    expect(Number((await q<{ n: string }>(db, 'SELECT count(*) AS n FROM matrix_cells WHERE level = 2'))[0]!.n)).toBeGreaterThanOrEqual(n); // kept
    expect(Number((await q<{ n: string }>(db, `SELECT count(*) AS n FROM matrix_cell_assignees a JOIN matrix_cells c ON c.id = a.cell_id WHERE c.level = 2`))[0]!.n)).toBeGreaterThan(0);
    const c = (await q<{ id: string; retired_at: string | null }>(db, `INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ('meetings', 2, 'any_one', 3, false, now()) RETURNING id, retired_at`))[0]!;
    expect(c.retired_at).not.toBeNull();
    await db.query('DELETE FROM matrix_cells WHERE id = $1', [c.id]);
  });
});

describe('Permits & HSE: each stream enters its own permits, L2 is the Team Lead of the same stream (Q90)', () => {
  /** A CW user and a TE user holding L1 of their stream's row in region R, their Team Leads at L2, and a site. */
  async function streams() {
    const cwEntry = await actor(app, db, { level: 'entry', grants: G('permits_hse', 'view', 'create', 'edit'), regions: [R], modules: null });
    const teEntry = await actor(app, db, { level: 'entry', grants: G('permits_hse', 'view', 'create', 'edit'), regions: [R], modules: null });
    const cwLead = await actor(app, db, { level: 'approve', grants: G('permits_hse', 'view', 'approve'), regions: [R], modules: null });
    const teLead = await actor(app, db, { level: 'approve', grants: G('permits_hse', 'view', 'approve'), regions: [R], modules: null });
    await regCell(db, 'permits_hse', R, 'entry', { user: [cwEntry.user.id] });
    await regCell(db, 'permits_hse', R, 'approve', { user: [cwLead.user.id] });
    await regCell(db, 'permits_hse_te', R, 'entry', { user: [teEntry.user.id] });
    await regCell(db, 'permits_hse_te', R, 'approve', { user: [teLead.user.id] });
    const site = await makeSite(db, R, { prefix: 'PM' });
    return { cwEntry, teEntry, cwLead, teLead, site };
  }
  const TE = { ...PERMIT_CW, permit_type: 'Access - TE' };

  it('refuses a TE permit from a CW-only user and allows it for the TE user; the CW user keeps the CW permits', async () => {
    const s = await streams();
    const refused = await s.cwEntry.api.call('post', recPath('permits_hse'), { site_id: s.site.id, data: TE });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('not_eligible_holder');
    expect(await q(db, `SELECT 1 FROM register_records WHERE site_id = $1`, [s.site.id])).toHaveLength(0);
    const ok = await s.teEntry.api.call('post', recPath('permits_hse'), { site_id: s.site.id, data: TE });
    expect(ok.status).toBe(201);
    // the TE user cannot enter a CW permit, a PTW of CW, or a City Council permit (0054, Q220: the Acquisition / RF & Design row)
    for (const permit_type of ['Access - CW', 'PTW - CW', 'City Council Permit']) {
      const no = await s.teEntry.api.call('post', recPath('permits_hse'), { site_id: s.site.id, data: { ...PERMIT_CW, permit_type } });
      expect(no.status, permit_type).toBe(403);
    }
    const cw = await s.cwEntry.api.call('post', recPath('permits_hse'), { site_id: s.site.id, data: PERMIT_CW });
    expect(cw.status).toBe(201);
    // moving a CW draft to a TE type is refused for the CW user, and nothing is written
    const move = await patch(s.cwEntry.api, 'permits_hse', cw.body.id, cw.body.version, { data: { permit_type: 'PTW - TE' } });
    expect(move.status).toBe(403);
    expect((await q<{ t: string }>(db, `SELECT data ->> 'permit_type' AS t FROM register_records WHERE id = $1`, [cw.body.id]))[0]!.t).toBe('Access - CW');
  });

  it('routes the approval of a TE permit to the TE Team Lead, and a CW permit to the CW Team Lead', async () => {
    const s = await streams();
    const te = await s.teEntry.api.call('post', recPath('permits_hse'), { site_id: s.site.id, data: TE });
    const sub = await s.teEntry.api.call('post', recPath('permits_hse', te.body.id, '/submit'), {}, { 'If-Match': `"${te.body.version}"` });
    expect(sub.status).toBe(200);
    expect(sub.body.state).toBe('in_approval');
    expect(sub.body.ball_in_court.holders.map((h: { ref_id: string }) => h.ref_id)).toEqual([s.teLead.user.id]);
    await s.cwLead.api.stepUp(s.cwLead.user.password);
    const wrong = await s.cwLead.api.call('post', recPath('permits_hse', te.body.id, '/approve'), {}, { 'If-Match': `"${sub.body.version}"` });
    expect(wrong.status).toBe(403);
    await s.teLead.api.stepUp(s.teLead.user.password);
    const ok = await s.teLead.api.call('post', recPath('permits_hse', te.body.id, '/approve'), {}, { 'If-Match': `"${sub.body.version}"` });
    expect(ok.status).toBe(200);
    expect(ok.body.state).toBe('approved');

    const cw = await s.cwEntry.api.call('post', recPath('permits_hse'), { site_id: s.site.id, data: { ...PERMIT_CW, permit_type: 'PTW - CW' } });
    expect(cw.status).toBe(201);
    const csub = await s.cwEntry.api.call('post', recPath('permits_hse', cw.body.id, '/submit'), {}, { 'If-Match': `"${cw.body.version}"` });
    expect(csub.status).toBe(200);
    expect(csub.body.ball_in_court.holders.map((h: { ref_id: string }) => h.ref_id)).toEqual([s.cwLead.user.id]);
  });

  it('seeded the defaults (L1 Site Engineers per stream, L2 the Team Lead of the same stream) and set the stream of the permit types', async () => {
    // other suites edit the global cells while this one runs, so the seed is read from its own audit row: 3 cells created, the untouched 0035 L2 (CW + TE lead) replaced
    const a = (await q<{ after: Record<string, any> }>(db, `SELECT after FROM audit_log WHERE action = 'permits_per_stream_applied' ORDER BY id LIMIT 1`))[0]!.after;
    expect(a).toMatchObject({ matrix_row: 'permits_hse_te', cells_seeded: 3, cells_replaced: 1 });
    // the TE row is a row of the Matrix with a global L1 and L2 cell
    expect(Number((await q<{ n: string }>(db, `SELECT count(*) AS n FROM matrix_cells WHERE register_key = 'permits_hse_te' AND region_id IS NULL AND level IN (1, 3)`))[0]!.n)).toBe(2);
    const types = await q<{ code: string; stream: string | null }>(db, `SELECT code, stream FROM permit_types WHERE stream IS NOT NULL ORDER BY code COLLATE "C"`);
    // 0054 (Q220): City Council and Civil Aviation are entered on the Acquisition / RF & Design stream; the purpose-based types have no fixed stream
    expect(types).toEqual([{ code: 'Access - CW', stream: 'CW' }, { code: 'Access - TE', stream: 'TE' }, { code: 'City Council Permit', stream: 'ACQ' },
      { code: 'Civil Aviation Authority Permit', stream: 'ACQ' }, { code: 'PTW - CW', stream: 'CW' }, { code: 'PTW - TE', stream: 'TE' }]);
  });

  it('has the TE row as a Matrix-only row (not an enabled register) mapped from Permits & HSE by permit stream', async () => {
    expect(await q(db, `SELECT 1 FROM register_definitions WHERE register_key = 'permits_hse_te' AND NOT enabled AND approval_levels = 2`)).toHaveLength(1);
    const rules = (await q<{ rules: Record<string, unknown> }>(db, `SELECT rules FROM register_definitions WHERE register_key = 'permits_hse'`))[0]!.rules;
    expect(rules).toMatchObject({ scope_from: 'permit_stream', scope_rows: { TE: 'permits_hse_te', ACQ: 'permits_hse_acq', OM: 'permits_hse_om' } });
    // the Matrix screen (GET /matrix) lists the row: see matrix.test.ts
  });
});
