import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, loggedIn, makeUser, startApp, superDb } from './helpers';
import { actor, addAssignment, makeSite, makeTask, newRole, plainAdmin, setCell, Site } from './wf-helpers';

/** The Site Register: site list (region and module scope, filters, streams), site detail, task grid. */
const PREFIX = `WFS${randomBytes(3).toString('hex').toUpperCase()}`;
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

const site = (region: number, over: { status?: string; scenario?: string } = {}): Promise<Site> => makeSite(db, region, { prefix: PREFIX, ...over });
const codes = (body: { items: { site_code: string }[] }): string[] => body.items.map((i) => i.site_code);

describe('visibility: region RLS and the module scope (B3)', () => {
  it('lists only the sites of the regions the caller holds for the sites module; a site outside answers 404', async () => {
    const tripoli = await site(1);
    const benghazi = await site(5);
    const a = await actor(app, db, { regions: [1] });
    const list = await a.api.call('get', `/sites?q=${PREFIX}&limit=200`);
    expect(list.status).toBe(200);
    expect(codes(list.body)).toContain(tripoli.code);
    expect(codes(list.body)).not.toContain(benghazi.code);
    expect((await a.api.call('get', `/sites/${tripoli.id}`)).status).toBe(200);
    const hidden = await a.api.call('get', `/sites/${benghazi.id}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe('not_found');
    expect((await a.api.call('get', `/sites/${benghazi.id}/tasks`)).status).toBe(404);
    expect((await a.api.call('get', `/sites/not-a-uuid`)).status).toBe(404);
    // the region filter cannot widen the scope
    const widen = await a.api.call('get', `/sites?q=${PREFIX}&region_id=5&region_id=1`);
    expect(codes(widen.body)).toEqual([tripoli.code]);

    const admin = await plainAdmin(app, db);
    expect(codes((await admin.api.call('get', `/sites?q=${PREFIX}&limit=200`)).body)).toEqual(expect.arrayContaining([tripoli.code, benghazi.code]));
  });

  it('scopes never cross: Tripoli for all modules plus Benghazi for the Warehouse only shows Tripoli sites', async () => {
    const tripoli = await site(1);
    const benghazi = await site(5);
    const user = await makeUser(db, { status: 'active' });
    await addAssignment(db, user.id, { level: 'entry', regions: [1], modules: null, grants: [['sites', 'view']] });
    await addAssignment(db, user.id, { level: 'entry', regions: [5], modules: ['warehouse'], grants: [['sites', 'view'], ['warehouse', 'view']] });
    const api = await loggedIn(app, user);
    const list = await api.call('get', `/sites?q=${PREFIX}&limit=200`);
    expect(codes(list.body)).toContain(tripoli.code);
    expect(codes(list.body)).not.toContain(benghazi.code);
    expect((await api.call('get', `/sites/${benghazi.id}`)).status).toBe(404);

    // add Benghazi for the sites module as well: now both
    await addAssignment(db, user.id, { level: 'entry', regions: [5], modules: ['sites'], grants: [['sites', 'view']] });
    const both = await api.call('get', `/sites?q=${PREFIX}&limit=200`);
    expect(codes(both.body)).toEqual(expect.arrayContaining([tripoli.code, benghazi.code]));
  });

  it('a caller without the sites module gets 403 module_forbidden everywhere', async () => {
    const s = await site(1);
    const a = await actor(app, db, { grants: [['warehouse', 'view']] });
    for (const path of ['/sites', `/sites/${s.id}`, `/sites/${s.id}/tasks`]) {
      const res = await a.api.call('get', path);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('module_forbidden');
    }
    // the grant exists but only for the Warehouse module of the assignment: the Sites module is not in its scope
    const scoped = await actor(app, db, { modules: ['warehouse'], grants: [['sites', 'view']] });
    expect((await scoped.api.call('get', '/sites')).status).toBe(403);
    expect((await new Api(app).call('get', '/sites')).status).toBe(401);
  });
});

describe('GET /sites: filters, sorting and paging', () => {
  it('filters by text, region, status, scenario, bucket and stage; sorts and pages', async () => {
    const a = await site(1, { scenario: 'expansion', status: 'not_started' });
    const b = await site(2, { scenario: 'new_build' });
    const c = await site(1, { scenario: 'new_build', status: 'completed' });
    await makeTask(db, b, 'B1', 'in_review');
    await makeTask(db, b, 'A1', 'approved');
    const admin = await plainAdmin(app, db);
    const q = `q=${PREFIX}&limit=200`;
    expect(codes((await admin.api.call('get', `/sites?${q}&scenario=expansion`)).body)).toEqual([a.code]);
    expect(codes((await admin.api.call('get', `/sites?${q}&overall_status=completed`)).body)).toEqual([c.code]);
    expect(codes((await admin.api.call('get', `/sites?${q}&region_id=2`)).body)).toEqual([b.code]);
    expect(codes((await admin.api.call('get', `/sites?${q}&bucket=waiting_approval`)).body)).toEqual([b.code]);
    expect(codes((await admin.api.call('get', `/sites?${q}&bucket=closed`)).body)).toContain(c.code);
    // the current stage of b: MS1 has all its counting tasks approved, so the site is in MS2 (B1 is in review)
    expect(codes((await admin.api.call('get', `/sites?${q}&stage_code=MS2`)).body)).toContain(b.code);
    expect(codes((await admin.api.call('get', `/sites?${q}&stage_code=MS1`)).body)).not.toContain(b.code);
    expect(codes((await admin.api.call('get', `/sites?${q}&stage_code=MS9`)).body)).not.toContain(b.code);

    const desc = await admin.api.call('get', `/sites?${q}&sort=-site_code`);
    expect(codes(desc.body)).toEqual([...codes(desc.body)].sort().reverse());
    const byRegion = await admin.api.call('get', `/sites?${q}&sort=-region`);
    const regionsDesc = byRegion.body.items.map((i: { region_id: number }) => i.region_id);
    expect(regionsDesc).toEqual([...regionsDesc].sort((x: number, y: number) => y - x));

    const p1 = await admin.api.call('get', `/sites?q=${PREFIX}&limit=2`);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.page.next_cursor).toBeTruthy();
    expect(p1.body.page.total).toBeGreaterThanOrEqual(3);
    const p2 = await admin.api.call('get', `/sites?q=${PREFIX}&limit=2&cursor=${p1.body.page.next_cursor}`);
    expect(codes(p2.body)).not.toContain(codes(p1.body)[0]);

    for (const bad of ['scenario=nope', 'overall_status=x', 'bucket=y', 'sort=z', 'region_id=9', 'limit=0', 'stream=lower', 'stream=NOPE']) {
      const res = await admin.api.call('get', `/sites?${bad}`);
      expect(res.status, bad).toBe(422);
    }
    expect((await admin.api.call('get', '/sites?cursor=zzz')).status).toBe(400);
  });

  it('bucket=mine lists the sites where the caller holds or is asked to act', async () => {
    const mine = await site(5);
    const other = await site(5);
    const e = await actor(app, db, { level: 'entry' });
    await makeTask(db, mine, 'A1', 'open');
    await makeTask(db, other, 'A1', 'open');
    // the cell is region-wide, so both sites are "mine"; a pinned task of another user hides nothing, so check with a second user
    await setCell(db, 'A1', 5, 'entry', { user: [e.user.id] });
    const res = await e.api.call('get', `/sites?q=${PREFIX}&bucket=mine&limit=200`);
    expect(codes(res.body)).toEqual(expect.arrayContaining([mine.code, other.code]));
    const stranger = await actor(app, db, { level: 'entry' });
    expect(codes((await stranger.api.call('get', `/sites?q=${PREFIX}&bucket=mine&limit=200`)).body)).not.toContain(mine.code);
  });
});

describe('streams (owner decision 2026-10-29)', () => {
  it('has the four default streams mapped from the stages and versioned with the workflow', async () => {
    const r = await db.query(`SELECT s.code AS stream, array_agg(st.seq ORDER BY st.seq) AS seqs FROM workflow_streams s
      JOIN workflow_definitions w ON w.id = s.workflow_id AND w.version = 1
      JOIN stage_definitions st ON st.workflow_id = s.workflow_id AND st.stream_code = s.code GROUP BY s.code, s.sort_order ORDER BY s.sort_order`);
    expect(r.rows).toEqual([
      { stream: 'DESIGN_ACQ', seqs: [1] },
      { stream: 'CW', seqs: [2, 3, 4] },
      { stream: 'TE', seqs: [5, 6, 7, 8] },
      { stream: 'CLOSURE', seqs: [9, 10] },
    ]);
  });

  it('shows the status of each site per stream and restricts the list to one stream', async () => {
    const s = await site(1);
    const onlyDesign = await site(1);
    // design: A1 and the MS1 milestone task approved; civil works started with one late task in review
    await makeTask(db, s, 'A1', 'approved');
    await makeTask(db, s, 'MS1', 'approved', { actualDate: '2026-03-02' });
    await makeTask(db, s, 'B1', 'entry', { dueDate: '2099-12-31' });   // an explicit due date: the SLA clock is not started over it (migration 0017)
    await makeTask(db, s, 'B2', 'locked');
    await makeTask(db, s, 'B3', 'in_review', { dueDate: '2026-01-01' });
    await makeTask(db, s, 'D1', 'locked');
    await makeTask(db, onlyDesign, 'A1', 'entry');
    const admin = await plainAdmin(app, db);

    const all = await admin.api.call('get', `/sites?q=${s.code}`);
    const item = all.body.items[0];
    const byCode = Object.fromEntries(item.streams.map((x: { code: string }) => [x.code, x]));
    expect(item.streams.map((x: { code: string }) => x.code)).toEqual(['DESIGN_ACQ', 'CW', 'TE', 'CLOSURE']);
    expect(byCode.DESIGN_ACQ).toMatchObject({ state: 'done', current_stage: null, milestone_date: '2026-03-02', done_tasks: 1, total_tasks: 1 });
    expect(byCode.CW).toMatchObject({ state: 'in_progress', current_stage: 'MS2', done_tasks: 0, total_tasks: 3, late_count: 1, milestone_date: null });
    expect(byCode.TE).toMatchObject({ state: 'not_started', current_stage: 'MS5', total_tasks: 1 });
    expect(byCode.CLOSURE).toMatchObject({ state: 'na' });
    expect(byCode.CW.name_en).toBe('Civil Works');
    expect(byCode.CW.name_ar).toBeTruthy();

    // one stream: only the stages of the stream in the rail, late and waiting counts of that stream only
    const cw = await admin.api.call('get', `/sites?q=${PREFIX}&stream=CW&limit=200`);
    expect(codes(cw.body)).toContain(s.code);
    expect(codes(cw.body)).not.toContain(onlyDesign.code); // no task in the stream
    const cwItem = cw.body.items.find((i: { site_code: string }) => i.site_code === s.code);
    expect(cwItem.rail.map((n: { code: string }) => n.code)).toEqual(['MS2', 'MS3', 'MS4']);
    expect(cwItem.rail[0].state).toBe('late');
    expect(cwItem.late_task_count).toBe(1);
    expect(cwItem.waiting_approval_count).toBe(1);
    expect(cwItem.next_milestone).toBe('MS2');
    const design = await admin.api.call('get', `/sites?q=${PREFIX}&stream=DESIGN_ACQ&limit=200`);
    expect(codes(design.body)).toEqual(expect.arrayContaining([s.code, onlyDesign.code]));
    expect(design.body.items.find((i: { site_code: string }) => i.site_code === s.code).late_task_count).toBe(0);
    expect(codes((await admin.api.call('get', `/sites?q=${PREFIX}&stream=DESIGN_ACQ&stage_code=MS1`)).body)).toContain(onlyDesign.code);
    expect(codes((await admin.api.call('get', `/sites?q=${PREFIX}&stream=CW&bucket=late`)).body)).toEqual([s.code]);

    // the task grid by stream
    const grid = await admin.api.call('get', `/sites/${s.id}/tasks?stream=CW`);
    expect(grid.status).toBe(200);
    expect(grid.body.stages.map((x: { code: string }) => x.code)).toEqual(['MS2', 'MS3', 'MS4']);
    expect(grid.body.stages[0].stream_code).toBe('CW');
    expect(grid.body.stages[0].tasks.map((t: { task_code: string }) => t.task_code)).toEqual(['B1', 'B2', 'B3']);
    expect(grid.body.streams.map((x: { code: string }) => x.code)).toEqual(['DESIGN_ACQ', 'CW', 'TE', 'CLOSURE']);
    expect((await admin.api.call('get', `/sites/${s.id}/tasks?stream=NOPE`)).status).toBe(422);
    const full = await admin.api.call('get', `/sites/${s.id}/tasks`);
    expect(full.body.stages).toHaveLength(10);
  });

  it('a new draft version inherits the streams and the stage mapping of the previous version', async () => {
    const admin = await plainAdmin(app, db);
    const v1 = await db.query('SELECT id FROM workflow_definitions WHERE version = 1');
    const res = await db.query(`SELECT set_config('app.user_id', $1, false)`, [admin.user.id]);
    expect(res.rowCount).toBe(1);
    // the clone is made by the admin function; here the inheritance triggers are exercised directly
    const w = await db.query(`INSERT INTO workflow_definitions (version, status, effective_from, reason) VALUES ((SELECT max(version) + 1 FROM workflow_definitions), 'draft', current_date, 'test') RETURNING id`);
    try {
      const streams = await db.query('SELECT code FROM workflow_streams WHERE workflow_id = $1 ORDER BY sort_order', [w.rows[0].id]);
      expect(streams.rows.map((r) => r.code)).toEqual(['DESIGN_ACQ', 'CW', 'TE', 'CLOSURE']);
      const st = await db.query(`INSERT INTO stage_definitions (workflow_id, code, seq, name_en, milestone_name) VALUES ($1, 'MS3', 3, 'CW Completion', 'CW Completion') RETURNING stream_code`, [w.rows[0].id]);
      expect(st.rows[0].stream_code).toBe('CW');
      void v1;
    } finally {
      await db.query('DELETE FROM stage_definitions WHERE workflow_id = $1', [w.rows[0].id]);
      await db.query('DELETE FROM workflow_definitions WHERE id = $1', [w.rows[0].id]);
    }
  });
});

describe('GET /sites/{id} and the task grid', () => {
  it('returns the pipeline of milestones and gates, scope flags, counts, cluster progress and an ETag', async () => {
    const cluster = await db.query(`INSERT INTO clusters (cluster_code, region_id, kpi_acceptance_date) VALUES ($1, 1, '2026-06-01') RETURNING id`, [`CL-${PREFIX}`]);
    const s = await makeSite(db, 1, { prefix: PREFIX, cluster: cluster.rows[0].id });
    const mate = await makeSite(db, 1, { prefix: PREFIX, cluster: cluster.rows[0].id });
    await makeTask(db, mate, 'MS7', 'approved', { actualDate: '2026-05-01' });
    await makeTask(db, s, 'MS1', 'approved', { actualDate: '2026-02-01' });
    await makeTask(db, s, 'B1', 'locked');
    await makeTask(db, s, 'B8', 'locked');
    await db.query(`UPDATE sites SET scope_tower_erection = 'yes', address = 'Street 1', latitude = 32.5, longitude = 13.2 WHERE id = $1`, [s.id]);
    const admin = await plainAdmin(app, db);
    const res = await admin.api.call('get', `/sites/${s.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.etag).toMatch(/^"\d+"$/);
    const b = res.body;
    expect(b.site_code).toBe(s.code);
    expect(b.workflow_version).toBe(1);
    expect(b.scope_flags.tower_erection).toBe('yes');
    expect(b.latitude).toBe(32.5);
    expect(b.pipeline.filter((n: { kind: string }) => n.kind === 'milestone')).toHaveLength(10);
    expect(b.pipeline.filter((n: { kind: string }) => n.kind === 'gate')).toHaveLength(9);
    expect(b.pipeline[0]).toMatchObject({ code: 'MS1', kind: 'milestone', state: 'done', actual_date: '2026-02-01', progress: 1 });
    expect(b.pipeline[1]).toMatchObject({ code: 'G2', kind: 'gate', state: 'current', actual_date: '2026-02-01' });
    expect(b.pipeline[2]).toMatchObject({ code: 'MS2', state: 'current' });
    expect(b.pipeline.find((n: { code: string }) => n.code === 'G4').state).toBe('locked');
    expect(b.cluster_progress).toMatchObject({ cluster_code: `CL-${PREFIX}`, sites_total: 2, sites_at_te_pac: 1, kpi_acceptance_date: '2026-06-01' });
    expect(b.counts).toEqual({ open_snags: 0, open_issues: 0, documents_missing: 0 });
    expect(b.streams).toHaveLength(4);
    expect(b.current_milestone).toBe('MS1');
    expect(b.next_milestone).toBe('MS2');
    expect((await admin.api.call('get', `/sites/${s.id}`)).headers.etag).toBe(res.headers.etag);
  });

  it('groups the tasks by stage with state, holders, lock reasons and slot counts', async () => {
    const s = await site(5);
    const e = await actor(app, db, { level: 'entry' });
    await makeTask(db, s, 'A1', 'entry');
    await makeTask(db, s, 'A2', 'locked');
    const roleId = await newRole(db);
    await setCell(db, 'A1', 5, 'entry', { user: [e.user.id], role: [roleId] });
    const grid = await e.api.call('get', `/sites/${s.id}/tasks`);
    expect(grid.status).toBe(200);
    expect(grid.body.workflow_version).toBe(1);
    const ms1 = grid.body.stages[0];
    expect(ms1).toMatchObject({ code: 'MS1', stream_code: 'DESIGN_ACQ', name_en: 'Site Release' });
    const [a1, a2] = ms1.tasks;
    expect(a1).toMatchObject({ task_code: 'A1', state: 'entry', stream_code: 'DESIGN_ACQ', levels_required: 3, current_level: 1, slots_required: 0 });
    expect(a1.ball_in_court.level_kind).toBe('entry');
    expect(a1.ball_in_court.holders.map((h: { kind: string }) => h.kind).sort()).toEqual(['role', 'user']);
    expect(a1.ball_in_court.holders.find((h: { kind: string }) => h.kind === 'user')).toMatchObject({ user_id: e.user.id, employee_id: e.user.employeeId, account_status: 'active' });
    expect(a1.ball_in_court.no_eligible_holder).toBe(false);
    expect(a2).toMatchObject({ task_code: 'A2', state: 'locked' });
    expect(a2.lock_reasons[0]).toMatchObject({ kind: 'predecessor_not_approved', ref_code: 'A1' });
    expect(a2.ball_in_court).toBeUndefined();
    // SLA A-1 starts the day the task opens (migration 0017): zero days elapsed, green
    expect(a1.sla).toMatchObject({ code: 'A-1', colour: 'green', elapsed_wd: 0, min_wd: 10, max_wd: 20, start_event: 'OPEN', rule_set_version: 1 });
    expect(a1.sla.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(a2.sla).toMatchObject({ colour: 'none', elapsed_wd: null });
  });
});
