import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ago, buildFixture, q, wdBetween } from './dash-fixture';
import type { Fix } from './dash-fixture';
import { makeUser, startApp, superDbDash2 } from './helpers';
import { actor, addAssignment, plainAdmin, setCell } from './wf-helpers';
import type { Actor } from './wf-helpers';

/**
 * The dashboard follow-up of the owner answers of 2026-11-02 (migration 0046, contract 0.11.0): Q118 manual percentage of the central Project Status
 * items, Q121 the approved health index, Q122 delay attribution periods, Q126 the view filter, Q127 the Excel export and the snapshot schedule.
 * The data set is the one of dashboard.test.ts (dash-fixture.ts), in its own database (TEST_DATABASE_URL_DASH2), because this suite changes the
 * figures. Dates are "today minus n days" and working days are counted by the database, so nothing depends on the weekday; the schedule is tested
 * with fixed calendar dates.
 */
let app: NestExpressApplication;
let db: PgClient;
let fx: Fix;
let admin: Actor;
let pm: Actor;            // holds the seeded role PM on an all-regions assignment
let psEditor: Actor;      // holds dashboard.project_status edit for all regions
let psEditorTripoli: Actor; // the same grant for Tripoli only: not enough for a project-wide value
let tripoli: Actor;       // views the dashboard in Tripoli
let reviewer: Actor;      // L2 holder of B8 in Tripoli
let delayDelegate: Actor; // holds dashboard.delay edit in Tripoli
let exporter: Actor;
let t1b8: string;
let b1b8: string;

type J = Record<string, any>;
const DASH = '/dashboard';
const MANUAL = '/project-status/manual-items';

const get = async (a: Actor, qs = ''): Promise<J> => {
  const res = await a.api.call('get', `${DASH}${qs}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as J;
};
const item = (d: J, code: string): J => d.headline.project_status.activities.flatMap((a: J) => a.items).find((i: J) => i.code === code);
const act = (d: J, code: string): J => d.headline.project_status.activities.find((a: J) => a.code === code);
const addValue = (a: Actor, code: string, body: J) => a.api.call('post', `${MANUAL}/${code}/values`).send(body);

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_DASH2 as string });
  db = await superDbDash2();
  const x = await makeUser(db, { assigned: true });
  const y = await makeUser(db, { assigned: true });
  fx = await buildFixture(db, x.id, y.id);
  admin = await plainAdmin(app, db, true);
  const view: [string, string][] = [['dashboard', 'view'], ['sites', 'view']];
  pm = await actor(app, db, { regions: null, grants: view });
  const pmRole = (await q<{ id: string }>(db, `SELECT id FROM roles WHERE code = 'PM'`))[0]!.id;
  await addAssignment(db, pm.user.id, { roleId: pmRole, level: 'view', regions: null, grants: view });
  psEditor = await actor(app, db, { regions: null, grants: [...view, ['dashboard.project_status', 'edit']] });
  psEditorTripoli = await actor(app, db, { regions: [1], grants: [...view, ['dashboard.project_status', 'edit']] });
  tripoli = await actor(app, db, { regions: [1], grants: [...view, ['issues', 'view']] });
  reviewer = await actor(app, db, { regions: [1], level: 'approve', grants: [...view, ['sites', 'approve'], ['approvals', 'view'], ['approvals', 'approve']] });
  delayDelegate = await actor(app, db, { regions: [1], grants: [...view, ['dashboard.delay', 'edit']] });
  exporter = await actor(app, db, { regions: null, grants: [...view, ['dashboard', 'export'], ['issues', 'view']] });
  await setCell(db, 'B8', 1, 'approve', { user: [reviewer.user.id] });
  t1b8 = (await q<{ id: string }>(db, 'SELECT id FROM task_instances WHERE site_id = $1 AND task_def_id = $2', [fx.site.T1!.id, fx.td.B8]))[0]!.id;
  b1b8 = (await q<{ id: string }>(db, 'SELECT id FROM task_instances WHERE site_id = $1 AND task_def_id = $2', [fx.site.B1!.id, fx.td.B8]))[0]!.id;
});

afterAll(async () => {
  await db.end();
  await app.close();
});

// ---------------------------------------------------------------------------------------------------------------------------- Q118
describe('Q118: manual percentage of the central Project Status items', () => {
  it('lists the 14 weighted central items (3.10 has weight 0), with no value yet; the figure is the 0039 one', async () => {
    const r = await pm.api.call('get', MANUAL);
    expect(r.status).toBe(200);
    expect(r.body.can_edit).toBe(true);
    const codes = r.body.items.filter((i: J) => i.weight > 0).map((i: J) => i.item_code);
    expect(codes).toEqual(['1.3', '1.5', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8', '3.9', '6.1', '6.6', '7.7', '8.1']);
    expect(r.body.without_value).toBe(14);
    expect(r.body.items.every((i: J) => i.current === null && i.history.length === 0)).toBe(true);
    expect((await get(admin)).headline.project_status.progress_pct).toBeCloseTo(40.217, 2);
    expect((await get(tripoli)).meta.central_items_hidden).toBe(14);
  });

  it('only the Project Manager, a System Admin or an all-regions holder of dashboard.project_status edit may enter a value', async () => {
    const body = { value_pct: 10, effective_date: await ago(db, 40), reason: 'probe' };
    expect((await addValue(tripoli, '1.3', body)).status).toBe(403);
    expect((await addValue(psEditorTripoli, '1.3', body)).status).toBe(403);
    expect((await tripoli.api.call('get', MANUAL)).body.can_edit).toBe(false);
    expect((await psEditor.api.call('get', MANUAL)).body.can_edit).toBe(true);
    expect((await admin.api.call('get', MANUAL)).body.can_edit).toBe(true);
    expect((await q(db, 'SELECT 1 FROM ps_manual_values'))).toHaveLength(0);
  });

  it('refuses a value out of range, a future date, an item that is not central or not weighted, and a missing reason', async () => {
    const today = fx.today;
    const future = (await q<{ d: string }>(db, 'SELECT (cal_today() + 1)::text AS d'))[0]!.d;
    const bad = async (code: string, body: J, path: string, errCode?: string) => {
      const r = await addValue(pm, code, body);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(r.body.errors.some((e: J) => e.path === path && (!errCode || e.code === errCode)), JSON.stringify(r.body)).toBe(true);
    };
    await bad('8.1', { value_pct: 101, effective_date: today, reason: 'too much' }, '/value_pct');
    await bad('8.1', { value_pct: 12.3456, effective_date: today, reason: 'decimals' }, '/value_pct');
    await bad('8.1', { value_pct: 10, effective_date: future, reason: 'future' }, '/effective_date', 'in_future');
    await bad('4.1', { value_pct: 10, effective_date: today, reason: 'task item' }, '/item_code', 'not_central_item');
    await bad('3.10', { value_pct: 10, effective_date: today, reason: 'weight 0' }, '/item_code', 'not_central_item');
    await bad('8.1', { value_pct: 10, effective_date: today, reason: ' ' }, '/reason');
    expect((await addValue(pm, '8.1', { value_pct: 10, effective_date: today })).status).toBe(422);
  });

  it('counts the values in force by their weight in the headline figure (computed by hand)', async () => {
    const r1 = await addValue(pm, '8.1', { value_pct: 20, effective_date: await ago(db, 30), reason: 'vendor training started' });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body).toMatchObject({ item_code: '8.1', version: 1, value_pct: 20 });
    expect((await addValue(pm, '8.1', { value_pct: 50, effective_date: await ago(db, 5), reason: 'half of the courses given' })).body.version).toBe(2);
    expect((await addValue(psEditor, '3.2', { value_pct: 40, effective_date: await ago(db, 5), reason: 'BTS received 40 of 100' })).status).toBe(201);
    const d = await get(admin);
    // 0039 figure: (12 + 15.625 + 0 + 2.8636 + 3.25 + 1.25) / 87 = 40.217. Now A3 is measured by 3.2 alone (40%, weight 5 joins the total), and
    // A8 = (50 x 50% + 50 x 25%) / 100 = 37.5% -> (12 + 15.625 + 5 x 0.4 + 0 + 2.8636 + 3.25 + 5 x 0.375) / 92 = 37.6136 / 92 = 40.884
    expect(d.headline.project_status.progress_pct).toBeCloseTo(40.884, 2);
    expect(act(d, 'A3')).toMatchObject({ measured: true });
    expect(act(d, 'A3').progress_pct).toBeCloseTo(40, 2);
    expect(act(d, 'A8').progress_pct).toBeCloseTo(37.5, 2);
    expect(item(d, '8.1')).toMatchObject({ measured: true, progress_pct: 50, reason: null, central: true, manual: { value_pct: 50, version: 2 } });
    expect(item(d, '1.3')).toMatchObject({ measured: false, reason: 'no_data', manual: null });
    expect(d.meta.central_items_hidden).toBe(0);
    expect(d.meta.manual_items_measured).toBe(2);
    const ps = await admin.api.call('get', '/project-status');
    expect(ps.body.progress_pct).toBeCloseTo(40.884, 2);
  });

  it('counts them in a regional figure too: central_items_hidden falls by the items that have a value', async () => {
    const d = await get(tripoli);
    // 0039 Tripoli: (12 + 17.5 + 0 + 3.0545 + 5.2 + 2) / 87 = 45.695 (8.2 at Tripoli = 2 of 5 sites); A8 becomes (50 x 0.5 + 50 x 0.4) / 100 = 0.45
    const old = 0.45695 * 87;
    expect(d.headline.project_status.progress_pct).toBeCloseTo(((old + 5 * 0.4 + 5 * (0.45 - 0.4)) / 92) * 100, 1);
    expect(d.meta.central_items_hidden).toBe(12);
    expect(item(d, '1.3')).toMatchObject({ measured: false });
    expect(item(d, '8.1')).toMatchObject({ measured: true, progress_pct: 50 });
  });

  it('a past reference date uses the value in force on that date', async () => {
    const d10 = await get(admin, `?ref_date=${await ago(db, 10)}`);
    expect(d10.basis.source).toBe('as_of_computed');
    expect(item(d10, '8.1')).toMatchObject({ measured: true, progress_pct: 20, manual: { value_pct: 20, version: 1 } });
    expect(item(d10, '3.2')).toMatchObject({ measured: false }); // in force from 5 days ago only
    const d40 = await get(admin, `?ref_date=${await ago(db, 40)}`);
    expect(item(d40, '8.1')).toMatchObject({ measured: false, manual: null });
  });

  it('a saved snapshot keeps the values known when it was taken: a later back-dated entry moves the computed dates, not the snapshot', async () => {
    const d3 = await ago(db, 3);
    expect((await q<{ n: number }>(db, 'SELECT dash_snapshot_take($1::date) AS n', [d3]))[0]!.n).toBe(9);
    expect((await addValue(pm, '8.1', { value_pct: 70, effective_date: await ago(db, 4), reason: 'correction from the training log' })).body.version).toBe(3);
    const snap = await get(admin, `?ref_date=${d3}`);
    expect(snap.basis.source).toBe('snapshot');
    expect(item(snap, '8.1')).toMatchObject({ progress_pct: 50, manual: { version: 2 } });
    const d2 = await get(admin, `?ref_date=${await ago(db, 2)}`);
    expect(d2.basis.source).toBe('as_of_computed');
    expect(item(d2, '8.1')).toMatchObject({ progress_pct: 70, manual: { version: 3 } });
    // the stored project row of the snapshot holds the figure of the time (A8 37.5% then)
    const row = await q<{ pct: string }>(db, 'SELECT actual_pct::text AS pct FROM progress_snapshots WHERE snapshot_date = $1 AND is_global', [d3]);
    expect(Number(row[0]!.pct)).toBeCloseTo(snap.headline.project_status.progress_pct, 2);
  });

  it('keeps the whole history per item with a version, who and why, and audits every entry', async () => {
    const r = await tripoli.api.call('get', MANUAL);
    const t = r.body.items.find((i: J) => i.item_code === '8.1');
    expect(t.current).toMatchObject({ value_pct: 70, version: 3 });
    expect(t.history.map((h: J) => [h.version, h.value_pct, h.in_force])).toEqual([[3, 70, true], [2, 50, false], [1, 20, false]]);
    expect(t.history[0]).toMatchObject({ reason: 'correction from the training log', entered_by: { id: pm.user.id } });
    expect(r.body.without_value).toBe(12);
    const audit = await q<{ entity_id: string; actor_id: string; before: J | null; after: J; reason: string }>(db,
      `SELECT entity_id, actor_id::text AS actor_id, before, after, reason FROM audit_log WHERE action = 'project_status.manual_value_set' ORDER BY id`);
    expect(audit.map((a) => a.entity_id)).toEqual(['8.1', '8.1', '3.2', '8.1']);
    expect(audit[1]!.before).toMatchObject({ value_pct: 20, version: 1 });
    expect(audit[3]!.before).toMatchObject({ value_pct: 50, version: 2 }); // the value in force on the new effective date before the entry
    expect(audit[2]!.actor_id).toBe(psEditor.user.id);
  });

  it('the values are append-only and the application role cannot write them', async () => {
    const full = await superDbDash2();
    try {
      await expect(full.query(`UPDATE ps_manual_values SET value_pct = 1`)).rejects.toThrow(/never rewritten/);
      await expect(full.query(`DELETE FROM ps_manual_values`)).rejects.toThrow(/never deleted/);
    } finally {
      await full.end();
    }
    const appDb = new PgClient({ connectionString: process.env.TEST_DATABASE_URL_DASH2 });
    await appDb.connect();
    try {
      await expect(appDb.query(`INSERT INTO ps_manual_values (item_code, version, value_pct, effective_date, reason, entered_by) VALUES ('1.3', 9, 1, cal_today(), 'x', $1)`, [pm.user.id])).rejects.toThrow(/permission denied/);
      await expect(appDb.query(`SELECT ps_manual_set('1.3', 1, cal_today(), 'no actor')`)).rejects.toThrow(/Project Manager/);
    } finally {
      await appDb.end();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------- Q121
describe('Q121: the health index is approved', () => {
  it('is no longer marked draft, and keeps factors D and I', async () => {
    const d = await get(admin);
    expect(d.health.draft).toBe(false);
    expect(d.meta.health_draft).toBe(false);
    expect(d.health.components.map((c: J) => c.code)).toEqual(['P', 'B', 'S', 'D', 'F', 'I']);
    const desc = await q<{ description: string }>(db, `SELECT description FROM settings WHERE key = 'dashboard.health_bands'`);
    expect(desc[0]!.description).not.toMatch(/draft/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------- Q122
describe('Q122: delay attribution periods', () => {
  const periods = (a: Actor, task: string) => a.api.call('get', `/tasks/${task}/delay-periods`);
  const addPeriod = (a: Actor, task: string, body: J) => a.api.call('post', `/tasks/${task}/delay-periods`).send(body);

  it('before any period: every late day goes to the default rule; the suspension of B1 is left out of the delay', async () => {
    // B1 is suspended 40 days ago and resumed 30 days ago: inside the window of its late B8 (due 60 days ago)
    await db.query(`INSERT INTO change_requests (change_code, site_id, region_id, kind, status, approval_date, is_global, requested_by) VALUES
      ('DASH2-S', $1, 5, 'suspension', 'approved', cal_today() - 40, false, $2), ('DASH2-R', $1, 5, 'resumption', 'approved', cal_today() - 30, false, $2)`, [fx.site.B1!.id, fx.userX]);
    const dl = (await get(admin)).delay;
    const suspended = await wdBetween(db, 41, 31);          // working days from 40 to 31 days ago
    expect(dl.periods_supported).toBe(true);
    expect(dl.suspended_working_days).toBe(suspended);
    // T1 B8 late since 30 days ago, B1 B8 since 60 days ago minus the suspension, T2 A2 (closed, no due date) its 4 days over the maximum
    expect(dl.total_late_working_days).toBe(await wdBetween(db, 30) + await wdBetween(db, 60) - suspended + 4);
    expect(dl.items.find((i: J) => i.party === 'cw_contractor')).toMatchObject({ kind: 'default_type', late_tasks: 2, late_working_days: await wdBetween(db, 30) + await wdBetween(db, 60) - suspended });
    expect(dl.items.find((i: J) => i.kind === 'unassigned')).toMatchObject({ late_working_days: 4 });
  });

  it('the reviewer (L2 holder) records a period; another viewer may not; the panel says who may', async () => {
    expect((await periods(reviewer, t1b8)).body).toMatchObject({ can_edit: true, items: [], parties: ['gecol', 'hlc', 'client', 'contractor', 'external', 'aljeel'] });
    expect((await periods(tripoli, t1b8)).body.can_edit).toBe(false);
    const body = { from_date: await ago(db, 20), to_date: await ago(db, 11), party: 'gecol', reason: 'no power from GECOL' };
    expect((await addPeriod(tripoli, t1b8, body)).status).toBe(403);
    const r = await addPeriod(reviewer, t1b8, body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ party: 'gecol', from_date: body.from_date, to_date: body.to_date, voided: false, created_by: { id: reviewer.user.id } });
    const audit = await q<{ site_id: string; region_id: number; actor_id: string }>(db,
      `SELECT site_id::text AS site_id, region_id, actor_id::text AS actor_id FROM audit_log WHERE action = 'delay_period.added' AND entity_id = $1`, [r.body.id]);
    expect(audit).toEqual([{ site_id: fx.site.T1!.id, region_id: 1, actor_id: reviewer.user.id }]);
  });

  it('attributes the covered working days to the party of the period (computed by hand)', async () => {
    const dl = (await get(admin)).delay;
    const gecol = await wdBetween(db, 21, 11);  // the working days from 20 to 11 days ago, all after the due date (30 days ago)
    const suspended = await wdBetween(db, 41, 31);
    expect(dl.items.find((i: J) => i.kind === 'period' && i.period_party === 'gecol')).toMatchObject({ party: 'gecol', late_tasks: 1, late_working_days: gecol });
    expect(dl.items.find((i: J) => i.party === 'cw_contractor').late_working_days).toBe(await wdBetween(db, 30) - gecol + await wdBetween(db, 60) - suspended);
    expect(dl.period_working_days).toBe(gecol);
    expect(dl.periods_count).toBe(1);
    expect(dl.total_late_working_days).toBe(await wdBetween(db, 30) + await wdBetween(db, 60) - suspended + 4);
    expect(dl.items.reduce((a: number, i: J) => a + i.share_pct, 0)).toBeCloseTo(100, 0);
  });

  it('refuses an overlapping period, a reversed one, an unknown party, and a task outside the caller\'s regions', async () => {
    const r1 = await addPeriod(reviewer, t1b8, { from_date: await ago(db, 12), to_date: await ago(db, 8), party: 'hlc', reason: 'overlaps the GECOL one' });
    expect(r1.status).toBe(422);
    expect(r1.body.errors[0]).toMatchObject({ path: '/from_date', code: 'period_overlap' });
    const r2 = await addPeriod(reviewer, t1b8, { from_date: await ago(db, 5), to_date: await ago(db, 7), party: 'hlc', reason: 'reversed' });
    expect(r2.status).toBe(422);
    expect(r2.body.errors[0]).toMatchObject({ path: '/to_date', code: 'before_from' });
    expect((await addPeriod(reviewer, t1b8, { from_date: await ago(db, 5), to_date: await ago(db, 3), party: 'aat_se', reason: 'never a party' })).status).toBe(422);
    expect((await addPeriod(reviewer, b1b8, { from_date: await ago(db, 5), to_date: await ago(db, 3), party: 'hlc', reason: 'Benghazi task' })).status).toBe(404);
    expect((await periods(reviewer, b1b8)).status).toBe(404);
  });

  it('a holder of dashboard.delay edit in the region records one too; a voided period stops counting and stays in the history', async () => {
    const r = await addPeriod(delayDelegate, t1b8, { from_date: await ago(db, 6), to_date: await ago(db, 2), party: 'contractor', external_party_id: fx.party, reason: 'crew not on site' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.external_party_name).toBe('Dash Test Vendor');
    let dl = (await get(admin)).delay;
    expect(dl.items.find((i: J) => i.kind === 'period' && i.period_party === 'contractor')).toMatchObject({ party: 'Dash Test Vendor', late_working_days: await wdBetween(db, 7, 2) });
    expect((await reviewer.api.call('post', `/tasks/${t1b8}/delay-periods/${r.body.id}/void`).send({})).status).toBe(422); // a reason is required
    const v = await reviewer.api.call('post', `/tasks/${t1b8}/delay-periods/${r.body.id}/void`).send({ reason: 'entered on the wrong task' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body).toMatchObject({ voided: true, void_reason: 'entered on the wrong task', voided_by: { id: reviewer.user.id } });
    expect((await reviewer.api.call('post', `/tasks/${t1b8}/delay-periods/${r.body.id}/void`).send({ reason: 'again' })).status).toBe(409);
    dl = (await get(admin)).delay;
    expect(dl.items.some((i: J) => i.period_party === 'contractor')).toBe(false);
    expect(dl.periods_count).toBe(1);
    const list = (await periods(tripoli, t1b8)).body.items;
    expect(list.map((p: J) => [p.party, p.voided])).toEqual([['gecol', false], ['contractor', true]]);
    // the same days may be recorded again once the first period is voided
    expect((await addPeriod(admin, t1b8, { from_date: await ago(db, 6), to_date: await ago(db, 6), party: 'client', reason: 'client closed the site' })).status).toBe(201);
    const audit = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'delay_period.voided' AND entity_id = $1`, [r.body.id]);
    expect(audit[0]!.n).toBe(1);
  });

  it('periods are never deleted or rewritten, and the application role cannot write them', async () => {
    const full = await superDbDash2();
    try {
      await expect(full.query(`UPDATE task_delay_periods SET from_date = from_date - 1`)).rejects.toThrow(/never rewritten/);
      await expect(full.query(`DELETE FROM task_delay_periods`)).rejects.toThrow(/never deleted/);
    } finally {
      await full.end();
    }
    const appDb = new PgClient({ connectionString: process.env.TEST_DATABASE_URL_DASH2 });
    await appDb.connect();
    try {
      await expect(appDb.query(`UPDATE task_delay_periods SET reason = 'x'`)).rejects.toThrow(/permission denied/);
      await expect(appDb.query(`SELECT delay_period_add($1, cal_today(), cal_today(), 'gecol', NULL, 'no actor')`, [t1b8])).rejects.toThrow(/sign in first/);
    } finally {
      await appDb.end();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------- Q126
describe('Q126: view filter (CW / TE / O&M)', () => {
  it('offers the views of the workflow beside the streams', async () => {
    const f = (await get(admin)).filters;
    expect(f.views.map((v: J) => v.code)).toEqual(['CW', 'TE', 'OM']);
    expect(f.streams.map((s: J) => s.code)).toContain('CW');
  });

  it('CW keeps the CW milestones and the CW tasks in the SLA and the delay; the figures are not project-wide', async () => {
    const d = await get(admin, '?view=CW');
    expect(d.pipeline.nodes.map((n: J) => n.code)).toEqual(['MS2', 'MS3', 'MS4']);
    expect(d.headline.sites_total).toBe(8);
    expect(d.meta.project_wide).toBe(false);
    expect(d.sla.by_stage.map((s: J) => s.stage_code)).toEqual(['MS3']); // B8 at T1 and B1; A2, D5 and D7 are not CW
    expect(d.sla.totals).toMatchObject({ open_late: 2, completed_late: 0, completed_on_time: 0, open_on_time: 0 });
    expect(d.delay.items.some((i: J) => i.kind === 'unassigned')).toBe(false); // the late A2 is not a CW task
  });

  it('TE keeps MS5 to MS9; O&M keeps Final Closure and the sites that have TE FAC or the closure task', async () => {
    const te = await get(admin, '?view=TE');
    expect(te.pipeline.nodes.map((n: J) => n.code)).toEqual(['MS5', 'MS6', 'MS7', 'MS8', 'MS9']);
    expect(te.sla.by_stage.map((s: J) => s.stage_code).sort()).toEqual(['MS5', 'MS6']);
    const om = await get(admin, '?view=OM');
    expect(om.pipeline.nodes.map((n: J) => n.code)).toEqual(['MS10']);
    expect(om.headline.sites_total).toBe(2); // T4 and T6 have a TE FAC (D18)
    expect((await get(admin, '?view=OM&stream=CW')).headline.sites_total).toBe(2);
  });

  it('refuses an unknown or malformed view', async () => {
    const r = await admin.api.call('get', `${DASH}?view=NOPE`);
    expect(r.status).toBe(422);
    expect(r.body.errors[0]).toMatchObject({ path: '/view', code: 'unknown_view' });
    expect((await admin.api.call('get', `${DASH}?view=cw`)).status).toBe(422);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------- Q127
describe('Q127: snapshot schedule', () => {
  it('a date is weekly on a Sunday and month_end on the last day of the month (fixed calendar dates)', async () => {
    const kinds = async (d: string) => (await q<{ k: string[] }>(db, 'SELECT dash_snapshot_kinds($1::date) AS k', [d]))[0]!.k;
    expect(await kinds('2026-05-31')).toEqual(['weekly', 'month_end']); // a Sunday that ends May
    expect(await kinds('2026-10-31')).toEqual(['month_end']);           // a Saturday
    expect(await kinds('2026-11-01')).toEqual(['weekly']);              // a Sunday
    expect(await kinds('2026-10-28')).toEqual([]);                      // a Wednesday
    expect(await kinds('2028-02-29')).toEqual(['month_end']);           // leap year
    await db.query(`UPDATE settings SET value = '3' WHERE key = 'dashboard.snapshot_weekday'`);
    try {
      expect(await kinds('2026-10-28')).toEqual(['weekly']);
    } finally {
      await db.query(`UPDATE settings SET value = '0' WHERE key = 'dashboard.snapshot_weekday'`);
    }
  });

  it('lists what is due within the catch-up window and not taken yet', async () => {
    const due = await q<{ d: string; kind: string }>(db, `SELECT snapshot_date::text AS d, kind FROM dash_snapshot_due('2026-11-03'::date)`);
    expect(due).toEqual([{ d: '2026-10-31', kind: 'month_end' }, { d: '2026-11-01', kind: 'weekly' }]);
    expect(await q(db, `SELECT * FROM dash_snapshot_due('2026-10-30'::date)`)).toEqual([{ snapshot_date: expect.anything(), kind: 'weekly' }]); // 2026-10-25
  });

  it('takes a date once even when it is both weekly and month-end, and never again', async () => {
    expect((await q<{ n: number }>(db, `SELECT dash_snapshot_scheduled('2026-06-01'::date) AS n`))[0]!.n).toBe(9);
    const runs = await q<{ kind: string; sites: number; source: string }>(db, `SELECT kind, sites, source FROM dash_snapshot_runs WHERE snapshot_date = '2026-05-31' ORDER BY kind`);
    // the first kind of the date stores the 9 sites; the second records its run and stores nothing new
    expect(runs).toEqual([{ kind: 'month_end', sites: 9, source: 'catch_up' }, { kind: 'weekly', sites: 0, source: 'catch_up' }]);
    expect((await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM site_snapshots WHERE snapshot_date = '2026-05-31'`))[0]!.n).toBe(9);
    expect((await q<{ n: number }>(db, `SELECT dash_snapshot_scheduled('2026-06-01'::date) AS n`))[0]!.n).toBe(0);
    expect((await q<{ n: number }>(db, `SELECT dash_snapshot_scheduled('2026-06-04'::date) AS n`))[0]!.n).toBe(0);
    await expect(db.query(`SELECT dash_snapshot_scheduled(cal_today() + 1)`)).rejects.toThrow(/future date/);
    const full = await superDbDash2();
    try {
      await expect(full.query(`UPDATE dash_snapshot_runs SET sites = 1`)).rejects.toThrow(/never rewritten/);
    } finally {
      await full.end();
    }
  });

  it('the snapshot lists show the kind: month_end wins over weekly, a snapshot taken by hand is manual', async () => {
    const list = await admin.api.call('get', '/project-status/snapshots?limit=200');
    expect(list.status).toBe(200);
    const may = list.body.items.find((i: J) => i.taken_on === '2026-05-31' && i.scope === 'project');
    expect(may).toMatchObject({ kind: 'month_end', kinds: ['month_end', 'weekly'] });
    const d3 = await ago(db, 3);
    expect(list.body.items.find((i: J) => i.taken_on === d3 && i.scope === 'project')).toMatchObject({ kind: 'manual', kinds: [] });
    const basis = (await get(admin)).basis;
    expect(basis.snapshot_kinds.find((s: J) => s.date === '2026-05-31')).toMatchObject({ kind: 'month_end' });
    expect(basis.snapshot_kinds.find((s: J) => s.date === d3)).toMatchObject({ kind: 'manual' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------- Q127 export
describe('Q127: Excel export', () => {
  const download = (a: Actor, qs: string) => a.api.call('get', `${DASH}/export${qs}`).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });

  it('downloads the view as an xlsx workbook by default; text that looks like a formula stays text', async () => {
    // a party whose name starts like a formula, made responsible for the late B8 at B1
    const evil = (await q<{ id: string }>(db, `INSERT INTO external_parties (name, type) VALUES ('=HYPERLINK("http://x.test","y")', 'cw_contractor') RETURNING id`))[0]!.id;
    await db.query(`UPDATE task_instances SET external_party_id = $1 WHERE id = $2`, [evil, b1b8]);
    const res = await download(exporter, '');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml\.sheet/);
    expect(res.headers['content-disposition']).toMatch(/GSDN_Dashboard_\d{4}-\d{2}-\d{2}\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet('Dashboard')!;
    expect(ws.getRow(1).values).toEqual([undefined, 'section', 'item', 'metric', 'value']);
    const rows: unknown[][] = [];
    ws.eachRow((r) => rows.push((r.values as unknown[]).slice(1)));
    expect(rows).toContainEqual(['headline', 'sites', 'active', 8]);
    expect(rows).toContainEqual(['project status', '8.1 Vendor training', 'manual %', 70]);
    let found = false;
    ws.eachRow((r) => r.eachCell((c) => {
      if (String(c.value).startsWith('=HYPERLINK')) {
        found = true;
        expect(c.type).toBe(ExcelJS.ValueType.String);
        expect(c.formula).toBeUndefined();
      }
    }));
    expect(found).toBe(true);
    expect(wb.getWorksheet('About')).toBeDefined();
    const audit = await q<{ after: J }>(db, `SELECT after FROM audit_log WHERE action = 'export' AND entity_type = 'dashboard' AND actor_id = $1 ORDER BY id DESC LIMIT 1`, [exporter.user.id]);
    expect(audit[0]!.after).toMatchObject({ format: 'xlsx' });
  });

  it('keeps CSV as an option, with the same formula guard, and refuses another format', async () => {
    const res = await download(exporter, '?format=csv&view=CW');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const body = (res.body as Buffer).toString('utf8');
    expect(body.charCodeAt(0)).toBe(0xfeff);
    expect(body).toContain(`"'=HYPERLINK(""http://x.test"",""y"")"`);
    expect((await exporter.api.call('get', `${DASH}/export?format=pdf`)).status).toBe(422);
    expect((await tripoli.api.call('get', `${DASH}/export`)).status).toBe(403);
  });
});
