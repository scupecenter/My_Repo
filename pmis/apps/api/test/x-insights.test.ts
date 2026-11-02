import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, loggedIn, makeUser, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { Actor, actor, addAssignment, makeSite, makeTask, newRole, plainAdmin, setCell } from './wf-helpers';

/**
 * X4 time in state, X5 workload and X6 blocked-by: region and module leaks, permission-denied cases, and figures from fixtures with fixed dates
 * (the audit rows are written with explicit timestamps in February 2026, so no figure depends on today's date, the weekday or the collation).
 * Region 7 (Sebha) and region 6 (GM) for sites; the task code B9 (it has an SLA rule, and no other test of this file makes one) for the workload cells in region 7.
 */
const R7 = 7;
const R6 = 6;
const PREFIX = `XN${randomBytes(3).toString('hex').toUpperCase()}`;
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

const site = (region = R7) => makeSite(db, region, { prefix: PREFIX });
const sitesView = (regions: number[] | null = [R7]) => actor(app, db, { level: 'view', grants: G('sites', 'view'), regions, modules: null });
const reports = (regions: number[] | null = [R7]) => actor(app, db, { level: 'view', grants: [...G('sites', 'view'), ...G('reports', 'view')], regions, modules: null });
const anon = (path: string) => request(app.getHttpServer()).get(`${API}${path}`);
const T0 = Date.UTC(2026, 1, 1, 8, 0, 0); // Sunday 1 February 2026 08:00 UTC
const at = (days: number, hours = 0): string => new Date(T0 + days * 86_400_000 + hours * 3_600_000).toISOString();

/** Audit rows with a known history for a task: [days after T0, actor, state]. */
async function history(taskId: string, s: { id: string; region: number }, rows: [number, string | null, string][]): Promise<void> {
  for (const [days, who, state] of rows) {
    await db.query(
      `INSERT INTO audit_log (at, actor_id, action, entity_type, entity_id, site_id, region_id, after)
       VALUES ($1, $2, 'task_step', 'task', $3, $4, $5, $6::jsonb)`,
      [at(days), who, taskId, s.id, s.region, JSON.stringify({ state })],
    );
  }
}

describe('X4 time in state of one task', () => {
  it('is 401 without a session, 403 without the Sites module, 404 in another region or for a malformed id, and readable without Reports', async () => {
    const s = await site();
    const tid = await makeTask(db, s, 'A1', 'open');
    expect((await anon(`/tasks/${tid}/time-in-state`)).status).toBe(401);
    const noModule = await actor(app, db, { level: 'view', grants: G('approvals', 'view'), regions: [R7], modules: ['approvals'] });
    expect((await noModule.api.call('get', `/tasks/${tid}/time-in-state`)).status).toBe(403);
    const far = await sitesView([R6]);
    expect((await far.api.call('get', `/tasks/${tid}/time-in-state`)).status).toBe(404);
    expect((await far.api.call('get', '/tasks/not-a-uuid/time-in-state')).status).toBe(404);
    expect((await far.api.call('get', '/tasks/00000000-0000-4000-8000-000000000000/time-in-state')).status).toBe(404);
    expect((await (await sitesView()).api.call('get', `/tasks/${tid}/time-in-state`)).status).toBe(200);
  });

  it('a task with no audited change has no time to show', async () => {
    const s = await site();
    const tid = await makeTask(db, s, 'A1', 'locked');
    const res = await (await sitesView()).api.call('get', `/tasks/${tid}/time-in-state`);
    expect(res.status).toBe(200);
    expect(res.body.current_state).toBeNull();
    expect(res.body.segments).toEqual([]);
    for (const i of res.body.items) expect(i).toMatchObject({ visits: 0, total_seconds: 0, longest_seconds: 0, working_days: 0 });
  });

  it('counts each visit from the audit rows, ends it at the next state, credits the person who ended it, and counts a return as a second visit', async () => {
    const e = await actor(app, db, { level: 'entry' });
    const a = await actor(app, db, { level: 'approve' });
    const s = await site();
    const tid = await makeTask(db, s, 'A1', 'approved');
    await history(tid, s, [
      [0, null, 'open'], // L1 from day 0
      [0.04, e.user.id, 'entry'], // same level: no new visit
      [2, e.user.id, 'in_approval'], // submitted on day 2: L1 lasted 2 days
      [3, a.user.id, 'rejected'], // rejected on day 3: L2 lasted 1 day, the person is the one who ended it
      [5, e.user.id, 'in_approval'], // L1 again for 2 days, submitted again
      [6, a.user.id, 'approved'], // L2 again for 1 day
    ]);
    const res = await (await sitesView()).api.call('get', `/tasks/${tid}/time-in-state`);
    expect(res.status).toBe(200);
    const by = (state: string) => res.body.items.find((i: { state: string }) => i.state === state);
    expect(by('entry')).toMatchObject({ visits: 2, total_seconds: 4 * 86_400, longest_seconds: 2 * 86_400 });
    expect(by('approve')).toMatchObject({ visits: 2, total_seconds: 2 * 86_400, longest_seconds: 86_400 });
    expect(by('entry').working_days).toBeGreaterThanOrEqual(2);
    expect(res.body.current_state).toBeNull(); // approved: nothing is open
    expect(res.body.segments.map((x: { state: string }) => x.state)).toEqual(['entry', 'approve', 'entry', 'approve']);
    expect(res.body.segments[0]).toMatchObject({ seconds: 2 * 86_400, ended_at: at(2) });
    expect(res.body.segments[0].handled_by).toMatchObject({ id: e.user.id, employee_id: e.user.employeeId });
    expect(res.body.segments[1].handled_by).toMatchObject({ id: a.user.id });
    // a sibling task's rows never leak into this one
    const other = await makeTask(db, s, 'A2', 'approved');
    await history(other, s, [[0, null, 'open'], [9, e.user.id, 'in_approval']]);
    const again = await (await sitesView()).api.call('get', `/tasks/${tid}/time-in-state`);
    expect(again.body.items.find((i: { state: string }) => i.state === 'entry').visits).toBe(2);
  });
});

describe('X4 report per person and per team', () => {
  async function fixture() {
    const e7 = await actor(app, db, { level: 'entry' });
    const e6 = await actor(app, db, { level: 'entry' });
    await db.query(`UPDATE user_role_assignments SET team = 'cw' WHERE user_id = $1`, [e7.user.id]);
    await db.query(`UPDATE user_role_assignments SET team = 'te' WHERE user_id = $1`, [e6.user.id]);
    const s7 = await site(R7);
    const s6 = await site(R6);
    const t7 = await makeTask(db, s7, 'A1', 'approved');
    const t6 = await makeTask(db, s6, 'A1', 'approved');
    await history(t7, s7, [[0, null, 'open'], [2, e7.user.id, 'in_approval'], [3, e7.user.id, 'approved']]);
    await history(t6, s6, [[10, null, 'open'], [11, e6.user.id, 'in_approval'], [12, e6.user.id, 'approved']]);
    return { e7, e6 };
  }
  const holders = (res: { body: { items: { holder: { id: string } }[] } }): string[] => res.body.items.map((i) => i.holder.id);

  it('counts only the tasks of the regions the reader holds on both Sites and Reports, and filters by region, stage and date', async () => {
    const { e7, e6 } = await fixture();
    const both = await reports([R7, R6]);
    const only7 = await reports([R7]);
    const q = '/reports/time-in-state?group_by=holder';
    expect(holders(await both.api.call('get', q))).toEqual(expect.arrayContaining([e7.user.id, e6.user.id]));
    const r7 = await only7.api.call('get', q);
    expect(holders(r7)).toContain(e7.user.id);
    expect(holders(r7)).not.toContain(e6.user.id);
    const row = r7.body.items.find((i: { holder: { id: string } }) => i.holder.id === e7.user.id);
    expect(row.levels.entry).toMatchObject({ visits: 1, total_seconds: 2 * 86_400, average_seconds: 2 * 86_400, max_seconds: 2 * 86_400 });
    // a region the reader does not hold: no rows of it, whatever is asked for (and no error that would tell it exists)
    const ask6 = await only7.api.call('get', `${q}&region_id=${R6}`);
    expect(ask6.status).toBe(200);
    expect(holders(ask6)).not.toContain(e6.user.id);
    // Sites in one region and Reports in another: the intersection is empty
    const split = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [R7], modules: null });
    await addAssignment(db, split.user.id, { roleId: await newRole(db), level: 'view', grants: G('reports', 'view'), regions: [R6], modules: null });
    const none = await split.api.call('get', q);
    expect(none.status).toBe(200);
    expect(holders(none)).not.toContain(e7.user.id);
    expect(holders(none)).not.toContain(e6.user.id);
    // date filters use the day the visit ended (fixture visits ended on 2026-02-03 and 2026-02-12)
    expect(holders(await both.api.call('get', `${q}&from=2026-02-05`))).toEqual(expect.arrayContaining([e6.user.id]));
    expect(holders(await both.api.call('get', `${q}&from=2026-02-05`))).not.toContain(e7.user.id);
    expect(holders(await both.api.call('get', `${q}&to=2026-02-05`))).not.toContain(e6.user.id);
    expect(holders(await both.api.call('get', `${q}&to=2026-02-05`))).toContain(e7.user.id);
    expect(holders(await both.api.call('get', `${q}&stage_code=no_such_stage`))).toEqual([]);
    // per team: the team of the person who handled the visit
    const teams = await both.api.call('get', '/reports/time-in-state?group_by=team');
    expect(teams.body.items.map((i: { team: string }) => i.team)).toEqual(expect.arrayContaining(['cw', 'te']));
  });

  it('is 401 without a session, 403 without Reports or without Sites, and 422 for a bad parameter', async () => {
    expect((await anon('/reports/time-in-state')).status).toBe(401);
    expect((await (await sitesView()).api.call('get', '/reports/time-in-state')).status).toBe(403);
    const reportsOnly = await actor(app, db, { level: 'view', grants: G('reports', 'view'), regions: [R7], modules: null });
    expect((await reportsOnly.api.call('get', '/reports/time-in-state')).status).toBe(403);
    const r = await reports();
    for (const q of ['group_by=x', 'region_id=0', 'region_id=8', 'region_id=abc', 'from=2026-13-40', 'from=02/01/2026', 'to=yesterday']) {
      expect((await r.api.call('get', `/reports/time-in-state?${q}`)).status, q).toBe(422);
    }
  });
});

describe('X5 workload', () => {
  async function fixture() {
    const h1 = await actor(app, db, { level: 'entry' });
    const h2 = await actor(app, db, { level: 'entry' });
    const h6 = await actor(app, db, { level: 'entry' });
    await db.query(`UPDATE user_role_assignments SET team = 'cw' WHERE user_id = $1`, [h1.user.id]);
    const s7 = await site(R7);
    const s6 = await site(R6);
    const rule = `(SELECT r.id FROM sla_rules r JOIN task_definitions td ON td.id = r.task_def_id WHERE td.code = 'B9' AND r.region_id IS NULL AND r.scenario IS NULL ORDER BY r.effective_from DESC LIMIT 1)`;
    const early = await makeTask(db, s7, 'B9', 'open');
    const late = await makeTask(db, await site(R7), 'B9', 'entry');
    const claimed = await makeTask(db, await site(R7), 'B9', 'open');
    const done = await makeTask(db, await site(R7), 'B9', 'approved');
    const locked = await makeTask(db, await site(R7), 'B9', 'locked');
    const noOne = await makeTask(db, s7, 'A2', 'open');
    const elsewhere = await makeTask(db, s6, 'B9', 'open');
    await setCell(db, 'B9', R7, 'entry', { user: [h1.user.id] });
    await setCell(db, 'B9', R6, 'entry', { user: [h6.user.id] });
    await setCell(db, 'A2', R7, 'entry', {});
    await db.query(`UPDATE task_instances SET sla_start_date = current_date, sla_rule_id = ${rule} WHERE id = $1`, [early]);
    await db.query(`UPDATE task_instances SET sla_start_date = current_date - 400, sla_rule_id = ${rule} WHERE id = $1`, [late]);
    await db.query(`UPDATE task_instances SET ball_in_court_user_id = $2 WHERE id = $1`, [claimed, h2.user.id]);
    void done;
    void locked;
    void noOne;
    void elsewhere;
    return { h1, h2, h6, ids: { early, late, claimed } };
  }
  const row = (res: { body: { items: { holder: { id: string } }[] } }, id: string) => res.body.items.find((i) => i.holder.id === id) as unknown as Record<string, any>;

  it('counts open and late tasks per holder, a claimed task for its claimant only, and leaves out approved and locked tasks', async () => {
    const { h1, h2 } = await fixture();
    const lead = await reports();
    const res = await lead.api.call('get', `/reports/workload?region_id=${R7}`);
    expect(res.status).toBe(200);
    expect(row(res, h1.user.id)).toMatchObject({ open: 2, late: 1, team: 'cw', by_level: { entry: 2, review: 0, approve: 0 } });
    expect(row(res, h1.user.id).holder).toMatchObject({ employee_id: h1.user.employeeId });
    expect(row(res, h2.user.id)).toMatchObject({ open: 1, late: 0 });
    expect(res.body.no_holder.open).toBeGreaterThanOrEqual(1);
    // a level nobody holds is counted apart, never under a person
    expect(res.body.items.every((i: { holder: { id: string } | null }) => i.holder && i.holder.id)).toBe(true);
    // the people with the most late tasks come first
    const lates = res.body.items.map((i: { late: number }) => i.late);
    expect(lates).toEqual([...lates].sort((x: number, y: number) => y - x));
  });

  it('never shows the holders of a region the reader does not hold, whatever is asked for', async () => {
    const { h1, h6 } = await fixture();
    const only7 = await reports([R7]);
    const all = await only7.api.call('get', '/reports/workload');
    expect(row(all, h1.user.id)).toBeTruthy();
    expect(row(all, h6.user.id)).toBeUndefined();
    const asked = await only7.api.call('get', `/reports/workload?region_id=${R6}`);
    expect(asked.status).toBe(200);
    expect(row(asked, h6.user.id)).toBeUndefined();
    expect(asked.body.items).toEqual([]);
    expect(asked.body.no_holder).toEqual({ open: 0, late: 0 });
    // Sites in one region and Reports in another: nothing
    const split = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [R7], modules: null });
    await addAssignment(db, split.user.id, { roleId: await newRole(db), level: 'view', grants: G('reports', 'view'), regions: [R6], modules: null });
    const none = await split.api.call('get', '/reports/workload');
    expect(none.body.items).toEqual([]);
    // a System Admin sees both
    const admin = await plainAdmin(app, db);
    const every = await admin.api.call('get', '/reports/workload');
    expect(row(every, h1.user.id)).toBeTruthy();
    expect(row(every, h6.user.id)).toBeTruthy();
    const stage = await admin.api.call('get', '/reports/workload?stage_code=no_such_stage');
    expect(stage.body.items).toEqual([]);
  });

  it('is 401 without a session, 403 without Reports or Sites, and 422 for a bad region', async () => {
    expect((await anon('/reports/workload')).status).toBe(401);
    expect((await (await sitesView()).api.call('get', '/reports/workload')).status).toBe(403);
    const reportsOnly = await actor(app, db, { level: 'view', grants: G('reports', 'view'), regions: [R7], modules: null });
    expect((await reportsOnly.api.call('get', '/reports/workload')).status).toBe(403);
    const r = await reports();
    for (const q of ['region_id=0', 'region_id=8', 'region_id=x']) expect((await r.api.call('get', `/reports/workload?${q}`)).status, q).toBe(422);
  });
});

describe('X6 blocked-by', () => {
  it('is 401 without a session, 403 without the Sites module, 404 in another region', async () => {
    const s = await site();
    const a2 = await makeTask(db, s, 'A2', 'locked');
    expect((await anon(`/tasks/${a2}/blocked-by`)).status).toBe(401);
    const noModule = await actor(app, db, { level: 'view', grants: G('approvals', 'view'), regions: [R7], modules: ['approvals'] });
    expect((await noModule.api.call('get', `/tasks/${a2}/blocked-by`)).status).toBe(403);
    expect((await (await sitesView([R6])).api.call('get', `/tasks/${a2}/blocked-by`)).status).toBe(404);
    expect((await (await sitesView()).api.call('get', `/tasks/${a2}/blocked-by`)).status).toBe(200);
  });

  it('lists only the predecessors that are not finished: an approved, not-applicable or skipped one is no reason', async () => {
    const e: Actor = await sitesView();
    for (const state of ['approved', 'na', 'skipped']) {
      const s = await site();
      await makeTask(db, s, 'A1', state);
      const a2 = await makeTask(db, s, 'A2', 'locked');
      const res = await e.api.call('get', `/tasks/${a2}/blocked-by`);
      expect(res.status).toBe(200);
      expect(res.body.items.filter((i: { kind: string }) => i.kind === 'predecessor_not_approved'), state).toEqual([]);
    }
    const s = await site();
    const a1 = await makeTask(db, s, 'A1', 'in_approval');
    const a2 = await makeTask(db, s, 'A2', 'locked');
    const res = await e.api.call('get', `/tasks/${a2}/blocked-by`);
    expect(res.body.blocked).toBe(true);
    const pred = res.body.items.find((i: { kind: string }) => i.kind === 'predecessor_not_approved');
    expect(pred.task).toMatchObject({ id: a1, task_code: 'A1', state: 'in_approval' });
    // the predecessor of another site is never named
    const t = await site();
    const b2 = await makeTask(db, t, 'A2', 'locked');
    const other = (await e.api.call('get', `/tasks/${b2}/blocked-by`)).body.items.find((i: { kind: string }) => i.kind === 'predecessor_not_approved');
    if (other?.task) expect(other.task.id).not.toBe(a1);
  });
});

describe('navigation keys of phase 4b (GET /me)', () => {
  it('gives every active user the inbox, readers of Sites the status updates, and readers of Sites and Reports the workload', async () => {
    const nav = async (a: Actor): Promise<string[]> => (await a.api.call('get', '/me')).body.effective.nav as string[];
    const plain = await actor(app, db, { level: 'view', grants: G('approvals', 'view'), regions: [R7], modules: null });
    const sites = await sitesView();
    const both = await reports();
    const reportsOnly = await actor(app, db, { level: 'view', grants: G('reports', 'view'), regions: [R7], modules: null });
    expect(await nav(plain)).toContain('inbox');
    expect(await nav(plain)).not.toContain('status_updates');
    expect(await nav(sites)).toEqual(expect.arrayContaining(['inbox', 'status_updates']));
    expect(await nav(sites)).not.toContain('workload');
    expect(await nav(both)).toEqual(expect.arrayContaining(['inbox', 'status_updates', 'workload']));
    expect(await nav(reportsOnly)).not.toContain('workload');
    expect(await nav(reportsOnly)).not.toContain('status_updates');
    const admin = await plainAdmin(app, db);
    expect(await nav(admin)).toEqual(expect.arrayContaining(['inbox', 'status_updates', 'workload']));
    // a pending user has no navigation at all, not even the inbox
    const pending = await loggedIn(app, await makeUser(db, {}));
    expect((await pending.call('get', '/me')).body.effective.nav).toEqual([]);
  });
});
