import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { actor, makeSite, makeTask, plainAdmin, Site } from './wf-helpers';

/** The CW / TE / O&M views of the Site Register (owner decision 2026-10-31, Q98): task-level groups beside the four streams. */
const PREFIX = `WFV${randomBytes(3).toString('hex').toUpperCase()}`;
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await setOm(false);
  await db.end();
  await app.close();
});

const site = (region: number, prefix = PREFIX): Promise<Site> => makeSite(db, region, { prefix });
const codes = (body: { items: { site_code: string }[] }): string[] => body.items.map((i) => i.site_code);
const setOm = (assigned: boolean): Promise<unknown> =>
  db.query(`INSERT INTO settings (key, value, updated_at) VALUES ('views.om_team_assigned', $1::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(assigned)]);
type Stage = { code: string; tasks: { task_code: string }[] };
const grid = (stages: Stage[]): Record<string, string[]> => Object.fromEntries(stages.map((s) => [s.code, s.tasks.map((t) => t.task_code)]));

/** One site with a task in every place the views care about. Only B3 (CW), F1 (stage 8) and the FACs are overdue. */
async function fullSite(region = 1, prefix = PREFIX): Promise<Site> {
  const s = await site(region, prefix);
  await makeTask(db, s, 'A1', 'entry');
  await makeTask(db, s, 'B3', 'in_review', { dueDate: '2026-01-01' });
  await makeTask(db, s, 'D1', 'locked');
  await makeTask(db, s, 'F1', 'entry', { dueDate: '2026-01-01' });
  await makeTask(db, s, 'D17', 'locked');
  await makeTask(db, s, 'B14', 'locked');
  await makeTask(db, s, 'B15', 'entry', { dueDate: '2026-01-01' });
  await makeTask(db, s, 'D18', 'locked');
  await makeTask(db, s, 'Z1', 'locked');
  return s;
}

describe('view definitions: seed data versioned with the workflow', () => {
  it('lists the three views with names, stages and tasks in force, in the task grid and (as references) on each site', async () => {
    await setOm(false);
    const s = await fullSite();
    const admin = await plainAdmin(app, db);
    const res = await admin.api.call('get', `/sites/${s.id}/tasks`);
    expect(res.status).toBe(200);
    expect(res.body.views.map((v: { code: string }) => v.code)).toEqual(['CW', 'TE', 'OM']);
    const by = Object.fromEntries(res.body.views.map((v: { code: string }) => [v.code, v]));
    expect(by.CW).toMatchObject({ name_en: 'Civil Works', sort_order: 1, stage_codes: ['MS2', 'MS3', 'MS4'], task_codes: ['B14', 'B15'] });
    expect(by.TE).toMatchObject({ name_en: 'Installation (TE)', stage_codes: ['MS5', 'MS6', 'MS7', 'MS8', 'MS9'], task_codes: [] }); // TE FAC (D18) is not TE work any more (Q102 final)
    expect(by.OM).toMatchObject({ name_en: 'O&M', stage_codes: [], task_codes: ['Z1', 'D18'] }); // O&M always lists everything after HOTO, whatever the switch says
    expect(by.CW.name_ar).toBeTruthy();
    // stage 1 and Final Closure (stage 10) are in no view as stages: Z1 is an O&M task member
    const members = [...by.CW.stage_codes, ...by.TE.stage_codes, ...by.OM.stage_codes];
    expect(members).not.toContain('MS1');
    expect(members).not.toContain('MS10');

    const list = await admin.api.call('get', `/sites?q=${s.code}`);
    expect(list.body.items[0].views).toEqual([
      expect.objectContaining({ code: 'CW', name_en: 'Civil Works' }), expect.objectContaining({ code: 'TE' }), expect.objectContaining({ code: 'OM', name_en: 'O&M' }),
    ]);
    expect(list.body.items[0].views[0].stage_codes).toBeUndefined();
    const detail = await admin.api.call('get', `/sites/${s.id}`);
    expect(detail.body.views).toHaveLength(3);
  });

  it('a new draft version inherits the views and their members', async () => {
    const w = await db.query(`INSERT INTO workflow_definitions (version, status, effective_from, reason) VALUES ((SELECT max(version) + 1 FROM workflow_definitions), 'draft', current_date, 'test') RETURNING id`);
    try {
      const v = await db.query('SELECT code FROM workflow_views WHERE workflow_id = $1 ORDER BY sort_order', [w.rows[0].id]);
      expect(v.rows.map((r) => r.code)).toEqual(['CW', 'TE', 'OM']);
      const m = await db.query('SELECT count(*)::int AS n FROM workflow_view_members WHERE workflow_id = $1', [w.rows[0].id]);
      expect(m.rows[0].n).toBe(12);
    } finally {
      await db.query('DELETE FROM workflow_definitions WHERE id = $1', [w.rows[0].id]);
    }
  });
});

describe('the task grid by view, and FAC before and after the O&M team is assigned (Q98)', () => {
  it('shows each view with its own tasks only; the O&M view always has TE FAC and Final Closure, whatever the O&M switch says', async () => {
    try {
      await setOm(false);
      const s = await fullSite();
      const admin = await plainAdmin(app, db);
      const cw = await admin.api.call('get', `/sites/${s.id}/tasks?view=CW`);
      expect(cw.status).toBe(200);
      expect(grid(cw.body.stages)).toEqual({ MS2: ['B3'], MS3: [], MS4: [], MS10: ['B14', 'B15'] });
      const te = await admin.api.call('get', `/sites/${s.id}/tasks?view=TE`);
      expect(grid(te.body.stages)).toEqual({ MS5: ['D1'], MS6: [], MS7: [], MS8: ['F1'], MS9: ['D17'] });
      const om = await admin.api.call('get', `/sites/${s.id}/tasks?view=OM`);
      expect(grid(om.body.stages)).toEqual({ MS10: ['D18', 'Z1'] });
      // stage 1 shows only in the all-work grid
      const all = grid((await admin.api.call('get', `/sites/${s.id}/tasks`)).body.stages);
      expect(all.MS1).toEqual(['A1']);
      expect(all.MS10).toEqual(['B14', 'B15', 'D18', 'Z1']);

      await setOm(true);
      const cw2 = await admin.api.call('get', `/sites/${s.id}/tasks?view=CW`);
      expect(grid(cw2.body.stages)).toEqual({ MS2: ['B3'], MS3: [], MS4: [], MS10: ['B14', 'B15'] });
      expect(grid((await admin.api.call('get', `/sites/${s.id}/tasks?view=TE`)).body.stages)).not.toHaveProperty('MS10');
      const om2 = await admin.api.call('get', `/sites/${s.id}/tasks?view=OM`);
      expect(grid(om2.body.stages)).toEqual({ MS10: ['D18', 'Z1'] }); // same membership after the assignment
      const defs = Object.fromEntries(om2.body.views.map((v: { code: string }) => [v.code, v]));
      expect(defs.OM.task_codes).toEqual(['Z1', 'D18']);
      expect(defs.CW.task_codes).toEqual(['B14', 'B15']);
    } finally {
      await setOm(false);
    }
  });

  it('combines with the stream filter: the tasks in both', async () => {
    await setOm(false);
    const s = await fullSite();
    const admin = await plainAdmin(app, db);
    const res = await admin.api.call('get', `/sites/${s.id}/tasks?view=TE&stream=CLOSURE`);
    expect(grid(res.body.stages)).toEqual({ MS9: ['D17'] });
    expect(grid((await admin.api.call('get', `/sites/${s.id}/tasks?view=TE&stream=CW`)).body.stages)).toEqual({});
  });
});

describe('GET /sites?view=: rail, late and waiting counts are computed over the view', () => {
  it('lists the sites with work in the view and counts only its tasks; TE FAC is O&M work with the switch off and on', async () => {
    try {
      await setOm(false);
      const own = `${PREFIX}L`; // this test counts the sites of its own prefix, so the other tests' sites are not in the lists
      const s = await fullSite(1, own);
      const designOnly = await site(1, own);
      await makeTask(db, designOnly, 'A1', 'entry');
      const facOnly = await site(1, own);
      await makeTask(db, facOnly, 'D18', 'entry', { dueDate: '2026-01-01' });
      const admin = await plainAdmin(app, db);
      const q = `q=${own}&limit=200`;
      const item = (body: { items: { site_code: string }[] }, code: string): Record<string, unknown> & { rail: { code: string; state: string }[] } =>
        body.items.find((i) => i.site_code === code) as never;

      const cw = (await admin.api.call('get', `/sites?${q}&view=CW`)).body;
      expect(codes(cw)).toContain(s.code);
      expect(codes(cw)).not.toContain(designOnly.code); // no task in the view
      expect(codes(cw)).not.toContain(facOnly.code); // TE FAC is not CW work
      expect(item(cw, s.code).rail.map((n) => n.code)).toEqual(['MS2', 'MS3', 'MS4', 'MS10']);
      expect(item(cw, s.code)).toMatchObject({ late_task_count: 2, waiting_approval_count: 1, next_milestone: 'MS2' }); // B3 and B15; B3 is in review

      const te = (await admin.api.call('get', `/sites?${q}&view=TE`)).body;
      expect(codes(te)).toContain(s.code);
      expect(codes(te)).not.toContain(facOnly.code); // TE FAC is O&M work
      expect(item(te, s.code)).toMatchObject({ late_task_count: 1, waiting_approval_count: 0 }); // F1 only: the CW late tasks are not counted
      const om0 = (await admin.api.call('get', `/sites?${q}&view=OM`)).body;
      expect(codes(om0)).toEqual(expect.arrayContaining([s.code, facOnly.code]));
      expect(item(om0, facOnly.code)).toMatchObject({ late_task_count: 1 });
      expect(item(om0, facOnly.code).rail.map((n) => n.code)).toContain('MS10');
      expect(codes((await admin.api.call('get', `/sites?${q}&view=TE&bucket=late`)).body)).toEqual([s.code]);
      expect(codes((await admin.api.call('get', `/sites?${q}&view=CW&bucket=waiting_approval`)).body)).toEqual([s.code]);
      expect(codes((await admin.api.call('get', `/sites?${q}&view=TE&bucket=waiting_approval`)).body)).toEqual([]);
      // the view and the stream filter together
      expect(codes((await admin.api.call('get', `/sites?${q}&view=TE&stream=CW`)).body)).toEqual([]);

      await setOm(true);
      expect(codes((await admin.api.call('get', `/sites?${q}&view=TE`)).body)).not.toContain(facOnly.code);
      expect(codes((await admin.api.call('get', `/sites?${q}&view=CW`)).body)).toEqual([s.code]);
      expect(item((await admin.api.call('get', `/sites?${q}&view=CW`)).body, s.code)).toMatchObject({ late_task_count: 2 });
      const om = (await admin.api.call('get', `/sites?${q}&view=OM`)).body;
      expect(codes(om)).toEqual(expect.arrayContaining([s.code, facOnly.code]));
      expect(item(om, facOnly.code)).toMatchObject({ late_task_count: 1 });
      expect(item(om, s.code)).toMatchObject({ late_task_count: 0 }); // D18 and Z1 are locked, not late; B14 and B15 are CW work
    } finally {
      await setOm(false);
    }
  });

  it('answers 422 for an unknown or malformed view code, in the list and in the task grid', async () => {
    const s = await site(1);
    const admin = await plainAdmin(app, db);
    for (const bad of ['view=NOPE', 'view=lower', 'view=A', 'view=CW&view=TE']) {
      const res = await admin.api.call('get', `/sites?${bad}`);
      expect(res.status, bad).toBe(422);
      expect(res.body.code).toBe('validation_failed');
    }
    const unknown = await admin.api.call('get', `/sites/${s.id}/tasks?view=NOPE`);
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0]).toMatchObject({ path: '/view', code: 'unknown_view' });
    expect((await admin.api.call('get', `/sites/${s.id}/tasks?view=cw`)).status).toBe(422);
  });
});

describe('scope: the view filter never widens what the caller may see', () => {
  it('limits the list to the caller\'s regions, hides other regions\' grids, and refuses a caller without the Sites module', async () => {
    const mine = await fullSite(1);
    const theirs = await fullSite(5);
    const a = await actor(app, db, { regions: [1] });
    const list = await a.api.call('get', `/sites?q=${PREFIX}&view=CW&limit=200`);
    expect(list.status).toBe(200);
    expect(codes(list.body)).toContain(mine.code);
    expect(codes(list.body)).not.toContain(theirs.code);
    expect((await a.api.call('get', `/sites?q=${PREFIX}&view=CW&region_id=5&region_id=1`)).body.items.map((i: { site_code: string }) => i.site_code)).not.toContain(theirs.code);
    expect((await a.api.call('get', `/sites/${mine.id}/tasks?view=TE`)).status).toBe(200);
    expect((await a.api.call('get', `/sites/${theirs.id}/tasks?view=TE`)).status).toBe(404);

    const denied = await actor(app, db, { grants: [['warehouse', 'view']] });
    for (const path of ['/sites?view=CW', `/sites/${mine.id}/tasks?view=CW`]) {
      const res = await denied.api.call('get', path);
      expect(res.status, path).toBe(403);
      expect(res.body.code).toBe('module_forbidden');
    }
  });
});
