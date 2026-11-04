import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ago, buildFixture, q, wdBetween } from './dash-fixture';
import type { Fix } from './dash-fixture';
import { makeUser, startApp, superDbDashP2 } from './helpers';
import { actor, addAssignment, plainAdmin, setCell } from './wf-helpers';
import type { Actor } from './wf-helpers';

/**
 * Work package P2 of the owner answers of 2026-11-04 (migration 0059, contract 0.12.7): Q7 unattributed delay, Q175 central items in the project
 * figure only, Q176 source, Q177 plans and the progress vs plan index, Q178 back-dating, Q180 effective suspension dates, Q181 rebuilt window,
 * Q182 proposed periods, Q184 the named party, Q186 historically unavailable gates, D16 draft factors, Q116 the pipeline setting, Q187 the workbook.
 * The data set is dash-fixture.ts in its own database (TEST_DATABASE_URL_DASHP2). Every date is "today minus n days" counted by the database, the
 * month limit uses the first day of the current month, and the plan arithmetic uses fixed calendar dates, so nothing depends on the weekday.
 */
let app: NestExpressApplication;
let db: PgClient;
let fx: Fix;
let admin: Actor;
let pm: Actor;        // the seeded role PM on an all-regions assignment, without the historical-correction right
let tripoli: Actor;   // views the dashboard in Tripoli
let l1: Actor;        // L1 (entry) of B8 in Tripoli
let reviewer: Actor;  // L2 of B8 in Tripoli
let exporter: Actor;
let t1b8: string;
let b1b8: string;

type J = Record<string, any>;
const DASH = '/dashboard';
const MANUAL = '/project-status/manual-items';
const get = async (a: Actor, qs = ''): Promise<J> => {
  const res = await a.api.call('get', `${DASH}${qs}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};
const item = (d: J, code: string): J => d.headline.project_status.activities.flatMap((a: J) => a.items).find((i: J) => i.code === code);
const day = async (sql: string): Promise<string> => (await q<{ d: string }>(db, `SELECT (${sql})::date::text AS d`))[0]!.d;

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_DASHP2 as string });
  db = await superDbDashP2();
  const x = await makeUser(db, { assigned: true });
  const y = await makeUser(db, { assigned: true });
  fx = await buildFixture(db, x.id, y.id);
  admin = await plainAdmin(app, db, true);
  const view: [string, string][] = [['dashboard', 'view'], ['sites', 'view']];
  pm = await actor(app, db, { regions: null, grants: view });
  const pmRole = (await q<{ id: string }>(db, `SELECT id FROM roles WHERE code = 'PM'`))[0]!.id;
  await addAssignment(db, pm.user.id, { roleId: pmRole, level: 'view', regions: null, grants: view });
  tripoli = await actor(app, db, { regions: [1], grants: view });
  l1 = await actor(app, db, { regions: [1], level: 'entry', grants: view });
  reviewer = await actor(app, db, { regions: [1], level: 'approve', grants: [...view, ['sites', 'approve']] });
  exporter = await actor(app, db, { regions: null, grants: [...view, ['dashboard', 'export'], ['issues', 'view']] });
  await setCell(db, 'B8', 1, 'entry', { user: [l1.user.id] });
  await setCell(db, 'B8', 1, 'approve', { user: [reviewer.user.id] });
  t1b8 = (await q<{ id: string }>(db, 'SELECT id FROM task_instances WHERE site_id = $1 AND task_def_id = $2', [fx.site.T1!.id, fx.td.B8]))[0]!.id;
  b1b8 = (await q<{ id: string }>(db, 'SELECT id FROM task_instances WHERE site_id = $1 AND task_def_id = $2', [fx.site.B1!.id, fx.td.B8]))[0]!.id;
});

afterAll(async () => {
  await db.end();
  await app.close();
});

// ---------------------------------------------------------------------------------------------------------------------------- D16
describe('D16: the draft label sits on the health factors not yet approved', () => {
  it('marks P, B, S and F draft, D and I approved; the index itself carries no draft label', async () => {
    const d = await get(admin);
    expect(d.health.draft).toBe(false);
    expect(d.health.components.map((c: J) => [c.code, c.draft])).toEqual([['P', true], ['B', true], ['S', true], ['D', false], ['F', true], ['I', false]]);
    expect(d.meta.health_draft_factors).toEqual(['P', 'B', 'S', 'F']);
    expect(d.health.approved_factors).toEqual(['D', 'I']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------- Q116
describe('Q116: the pipeline style is a setting, A by default', () => {
  it('is A; only an admin (or dashboard administer) changes it, with a reason, audited', async () => {
    expect((await get(tripoli)).meta.pipeline_variant).toBe('A');
    expect((await tripoli.api.call('put', `${DASH}/pipeline-variant`).send({ variant: 'B', reason: 'I like it' })).status).toBe(403);
    expect((await admin.api.call('put', `${DASH}/pipeline-variant`).send({ variant: 'C', reason: 'no such' })).status).toBe(422);
    expect((await admin.api.call('put', `${DASH}/pipeline-variant`).send({ variant: 'B' })).status).toBe(422);
    const r = await admin.api.call('put', `${DASH}/pipeline-variant`).send({ variant: 'B', reason: 'the owner picked the flat track' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ variant: 'B' });
    expect((await get(tripoli)).meta.pipeline_variant).toBe('B');
    const audit = await q<{ before: J; after: J; reason: string }>(db, `SELECT before, after, reason FROM audit_log WHERE action = 'settings.updated' AND entity_id = 'dashboard.pipeline_variant'`);
    expect(audit).toEqual([{ before: { value: 'A' }, after: { value: 'B' }, reason: 'the owner picked the flat track' }]);
    expect((await admin.api.call('put', `${DASH}/pipeline-variant`).send({ variant: 'A', reason: 'back to the default' })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------- Q349
describe('Q349: the site page follows the same pipeline setting as the dashboard', () => {
  it('SiteDetail.pipeline_variant is the setting dashboard.pipeline_variant, for every viewer of the site', async () => {
    const site = async (a: Actor): Promise<J> => {
      const r = await a.api.call('get', `/sites/${fx.site.T1!.id}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body;
    };
    expect((await site(tripoli)).pipeline_variant).toBe('A');
    expect((await admin.api.call('put', `${DASH}/pipeline-variant`).send({ variant: 'B', reason: 'the owner picked the flat track' })).status).toBe(200);
    expect((await site(tripoli)).pipeline_variant).toBe('B');
    expect((await site(admin)).pipeline_variant).toBe('B');
    expect((await get(tripoli)).meta.pipeline_variant).toBe('B');
    // nobody but the admin path changes it; a site of another region stays invisible (404) whatever the setting
    expect((await tripoli.api.call('put', `${DASH}/pipeline-variant`).send({ variant: 'A', reason: 'I do not like it' })).status).toBe(403);
    expect((await site(tripoli)).pipeline_variant).toBe('B');
    expect((await tripoli.api.call('get', `/sites/${fx.site.B1!.id}`)).status).toBe(404);
    expect((await admin.api.call('put', `${DASH}/pipeline-variant`).send({ variant: 'A', reason: 'back to the default' })).status).toBe(200);
    expect((await site(tripoli)).pipeline_variant).toBe('A');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------- Q175 - Q178
describe('Q176, Q178: manual values carry a source; back-dating stops at the current month', () => {
  it('refuses a value without its source', async () => {
    const r = await pm.api.call('post', `${MANUAL}/8.1/values`).send({ value_pct: 40, effective_date: fx.today, reason: 'no source' });
    expect(r.status).toBe(422);
    expect(r.body.errors.some((e: J) => e.path === '/source')).toBe(true);
    const appDb = new PgClient({ connectionString: process.env.TEST_DATABASE_URL_DASHP2 });
    await appDb.connect();
    try {
      // the 0046 signature without a source is refused too (after the right check: no actor here)
      await expect(appDb.query(`SELECT ps_manual_set('8.1', 40, cal_today(), 'no source')`)).rejects.toThrow(/Project Manager/);
    } finally {
      await appDb.end();
    }
  });

  it('accepts a date in the current month; an earlier one needs dashboard.historical_correction and is flagged', async () => {
    const first = await day(`date_trunc('month', cal_today())`);
    const prev = await day(`date_trunc('month', cal_today())::date - 1`);
    const ok = await pm.api.call('post', `${MANUAL}/8.1/values`).send({ value_pct: 40, effective_date: first, reason: 'training started', source: 'vendor training log' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ version: 1, value_pct: 40, source: 'vendor training log', historical_correction: false });
    const no = await pm.api.call('post', `${MANUAL}/8.1/values`).send({ value_pct: 10, effective_date: prev, reason: 'last month', source: 'vendor training log' });
    expect(no.status).toBe(403);
    expect(no.body.detail).toMatch(/historical correction/);
    const corr = await admin.api.call('post', `${MANUAL}/8.1/values`).send({ value_pct: 10, effective_date: prev, reason: 'last month was missed', source: 'monthly report' });
    expect(corr.status, JSON.stringify(corr.body)).toBe(201);
    expect(corr.body).toMatchObject({ version: 2, historical_correction: true });
    const list = (await pm.api.call('get', MANUAL)).body;
    expect(list).toMatchObject({ can_edit: true, can_correct_history: false, open_period_from: first });
    expect((await admin.api.call('get', MANUAL)).body.can_correct_history).toBe(true);
    const h = list.items.find((i: J) => i.item_code === '8.1');
    // the value in force today is still the one dated this month (the latest effective date wins)
    expect(h.current).toMatchObject({ value_pct: 40, version: 1, source: 'vendor training log' });
    expect(h.history.map((x: J) => [x.version, x.historical_correction, x.source])).toEqual([[2, true, 'monthly report'], [1, false, 'vendor training log']]);
    const audit = await q<{ after: J }>(db, `SELECT after FROM audit_log WHERE action = 'project_status.manual_value_set' ORDER BY id`);
    expect(audit.map((a) => [a.after.version, a.after.historical_correction, a.after.source])).toEqual([[1, false, 'vendor training log'], [2, true, 'monthly report']]);
  });
});

describe('Q175: a manual central value counts in the project-wide figure only', () => {
  it('moves the project figure (computed by hand)', async () => {
    const d = await get(admin);
    // 0039 figure: (12 + 15.625 + 0 + 2.8636 + 3.25 + 5 x 0.25) / 87 = 40.217. A8 with 8.1 at 40%: (50 x 0.4 + 50 x 0.25) / 100 = 0.325, so the A8 term is
    // 5 x 0.325 = 1.625 and the figure (12 + 15.625 + 0 + 2.8636 + 3.25 + 1.625) / 87 = 35.3636 / 87 = 40.648
    expect(d.headline.project_status.progress_pct).toBeCloseTo(40.648, 2);
    expect(item(d, '8.1')).toMatchObject({ measured: true, manual: { value_pct: 40, version: 1 } });
    expect(d.meta.central_items_hidden).toBe(0);
    expect(d.meta.manual_items_measured).toBe(1);
    expect(d.headline.project_status.central_line).toBeNull();
  });

  it('leaves it out of a region, a site and the region rows, and shows it on a separate central line', async () => {
    const d = await get(tripoli);
    // the 0039 Tripoli figure: (12 + 17.5 + 0 + 3.0545 + 5.2 + 2) / 87 = 45.695
    expect(d.headline.project_status.progress_pct).toBeCloseTo(45.695, 2);
    expect(d.meta.central_items_hidden).toBe(14);
    expect(item(d, '8.1')).toMatchObject({ measured: false, reason: 'central_hidden', manual: null });
    // the central line: 8.1 alone, 40%
    expect(d.headline.project_status.central_line).toMatchObject({ total: 14, measured: 1, progress_pct: 40, items: [{ code: '8.1', value_pct: 40, activity_code: 'A8' }] });
    // the region rows of the project-wide dashboard leave it out too
    expect((await get(admin)).regions.items.find((r: J) => r.region_id === 1).progress_pct).toBeCloseTo(45.695, 2);
    const site = await admin.api.call('get', `/project-status?site_id=${fx.site.T1!.id}`);
    expect(site.status).toBe(200);
    expect(site.body.central_line).toMatchObject({ measured: 1 });
    expect(site.body.central_items_hidden).toBe(14);
  });
});

describe('Q177: plans of the manual items and the progress vs plan index', () => {
  it('reads a plan on a date: 0 before the first point, a straight line between points, the last value after (fixed dates)', async () => {
    const pts = JSON.stringify([{ date: '2026-01-01', planned_pct: 0 }, { date: '2026-01-31', planned_pct: 60 }, { date: '2026-03-01', planned_pct: 100 }]);
    const at = async (d: string) => Number((await q<{ v: string }>(db, 'SELECT round(ps_plan_pct($1::jsonb, $2::date), 3)::text AS v', [pts, d]))[0]!.v);
    expect(await at('2025-12-31')).toBe(0);
    expect(await at('2026-01-01')).toBe(0);
    expect(await at('2026-01-16')).toBe(30);            // 60 x 15 / 30
    expect(await at('2026-02-15')).toBeCloseTo(80.69, 2); // 60 + 40 x 15 / 29
    expect(await at('2026-03-01')).toBe(100);
    expect(await at('2026-12-31')).toBe(100);
  });

  it('without a plan for 8.1 the partial index covers 1.1 and 5.2 only (computed by hand); Planned stays not available', async () => {
    const ps = (await get(admin)).headline.project_status;
    // items with a complete plan: 1.1 (A2 at T1 T2 B1, baselines MS1 all due: 100% done, 100% planned) and 5.2 (D5 at T1, MS5 due 10 days ago: 0% done, 100% planned)
    // pa = 12 x 1 + 20 x 0 = 12; pp = 12 + 20 = 32; index 12 / 32 = 0.375; coverage (12 + 20) / 87 = 36.782%
    expect(ps.planned_pct).toBeNull();
    expect(ps.progress_vs_plan_index).toBeNull();
    expect(ps.partial_index).toMatchObject({ value: 0.375, coverage_pct: 36.782, actual_pct: 37.5, planned_pct: 100 });
  });

  it('a target date gives a ramp from the start date; the plan then joins the partial index (computed by hand)', async () => {
    const start = await ago(db, 20);
    const target = await day('cal_today() + 20');
    const bad = async (body: J, path?: string) => {
      const r = await pm.api.call('post', `${MANUAL}/8.1/plan`).send(body);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      if (path) expect(r.body.errors.some((e: J) => e.path.startsWith(path)), JSON.stringify(r.body)).toBe(true);
    };
    await bad({ points: [{ date: '2026-01-01', planned_pct: 50 }, { date: '2026-02-01', planned_pct: 40 }], reason: 'falls', source: 'plan' }, '/points/1/planned_pct');
    await bad({ points: [{ date: '2026-01-01', planned_pct: 10 }, { date: '2026-01-01', planned_pct: 20 }], reason: 'twice', source: 'plan' }, '/points/1/date');
    await bad({ points: [{ date: '2026-01-01', planned_pct: 10 }], target_date: target, reason: 'both', source: 'plan' });
    await bad({ target_date: target, reason: 'no source' });
    await bad({ points: [{ date: '2026-01-01', planned_pct: 101 }], reason: 'too much', source: 'plan' });
    expect((await tripoli.api.call('post', `${MANUAL}/8.1/plan`).send({ target_date: target, reason: 'not mine', source: 'plan' })).status).toBe(403);
    expect((await pm.api.call('post', `${MANUAL}/4.1/plan`).send({ target_date: target, reason: 'task item', source: 'plan' })).status).toBe(422);
    const r = await pm.api.call('post', `${MANUAL}/8.1/plan`).send({ start_date: start, target_date: target, reason: 'approved training plan', source: 'vendor contract annex' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ version: 1, points: [{ date: start, planned_pct: 0 }, { date: target, planned_pct: 100 }], source: 'vendor contract annex' });
    const d = await get(admin);
    // today is halfway through the 40 days: 50%
    expect(item(d, '8.1')).toMatchObject({ plan: { planned_pct: 50, version: 1 } });
    // with 8.1 (A8, 50 of the 100 item weight: 5 x 50 / 100 = 2.5): pa = 12 + 0 + 2.5 x 0.4 = 13; pp = 12 + 20 + 2.5 x 0.5 = 33.25;
    // index 13 / 33.25 = 0.391; covered weight 12 + 20 + 2.5 = 34.5: coverage 34.5 / 87 = 39.655%, actual 13 / 34.5 = 37.681%, planned 33.25 / 34.5 = 96.377%
    expect(d.headline.project_status.partial_index).toMatchObject({ value: 0.391, coverage_pct: 39.655, actual_pct: 37.681, planned_pct: 96.377 });
    expect(d.headline.project_status.manual_items_planned).toBe(1);
    const list = (await tripoli.api.call('get', MANUAL)).body;
    expect(list.items.find((i: J) => i.item_code === '8.1').plan).toMatchObject({ version: 1, planned_pct_today: 50, source: 'vendor contract annex' });
    expect(list.without_plan).toBe(13);
    const audit = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'project_status.manual_plan_set' AND entity_id = '8.1'`);
    expect(audit[0]!.n).toBe(1);
    const full = await superDbDashP2();
    try {
      await expect(full.query(`UPDATE ps_manual_plans SET source = 'x'`)).rejects.toThrow(/never rewritten/);
    } finally {
      await full.end();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------- Q186
describe('Q186: blocked gates that cannot be known for a date are historically unavailable, not 0', () => {
  it('live: the gates and the pipeline say how many are blocked', async () => {
    const d = await get(admin);
    expect(d.gates).toMatchObject({ status: 'live', available: true, blocked_total: 2 });
    expect(d.meta.blocked_gates_available).toBe(true);
    expect(d.pipeline.nodes.find((n: J) => n.code === 'MS5')).toMatchObject({ blocked: 1, blocked_available: true });
  });

  it('a past date computed from dated facts: null, with the reason', async () => {
    const d = await get(admin, `?ref_date=${await ago(db, 25)}`);
    expect(d.gates).toMatchObject({ status: 'historically_unavailable', available: false, blocked_total: null });
    expect(d.pipeline.nodes.find((n: J) => n.code === 'MS5')).toMatchObject({ blocked: null, blocked_available: false });
    expect(d.basis.note).toMatch(/historically unavailable/);
  });

  it('a snapshot taken after its date stores null and is marked rebuilt; one taken on its own date keeps the count', async () => {
    const d3 = await ago(db, 3);
    expect((await q<{ n: number }>(db, 'SELECT dash_snapshot_take($1::date) AS n', [d3]))[0]!.n).toBe(9);
    const ms = await q<{ b: unknown }>(db, `SELECT ms -> 'MS5' -> 'blocked' AS b FROM site_snapshots WHERE snapshot_date = $1 AND site_id = $2`, [d3, fx.site.T1!.id]);
    expect(ms[0]!.b).toBeNull();
    const s3 = await get(admin, `?ref_date=${d3}`);
    expect(s3.basis.source).toBe('snapshot');
    expect(s3.gates).toMatchObject({ status: 'historically_unavailable', blocked_total: null });
    expect(s3.basis.snapshot_kinds.find((k: J) => k.date === d3)).toMatchObject({ kind: 'manual', rebuilt: true });
    // a snapshot stored on its own date (made so by hand here: the store time moved to noon of that date, Africa/Tripoli) with T1 held at G5
    const d2 = await ago(db, 2);
    await db.query('SELECT dash_snapshot_take($1::date)', [d2]);
    await db.query(`UPDATE site_snapshots SET created_at = (($1::date)::timestamp + interval '12 hours') AT TIME ZONE 'Africa/Tripoli',
      ms = CASE WHEN site_id = $2 THEN jsonb_set(ms, '{MS5,blocked}', 'true') ELSE ms END WHERE snapshot_date = $1::date`, [d2, fx.site.T1!.id]);
    const s2 = await get(admin, `?ref_date=${d2}`);
    expect(s2.gates).toMatchObject({ status: 'snapshot', available: false, blocked_total: 1 });
    expect(s2.pipeline.nodes.find((n: J) => n.code === 'MS5')).toMatchObject({ blocked: 1, blocked_available: true });
    expect(s2.basis.snapshot_kinds.find((k: J) => k.date === d2)).toMatchObject({ rebuilt: false });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------- delay
describe('Q180, Q181, Q7: the delay windows', () => {
  // T2 A2 is closed without a due date: its window is rebuilt from the SLA start (110 days ago) plus the A2 maximum (2 working days)
  const t2a2 = async (): Promise<number> => Math.max(0, (await wdBetween(db, 110, 100)) - 2);
  let suspB1 = 0;
  let suspT1 = 0;

  it('counts suspension days from the effective dates, falling back to the approval dates; a request does not count (computed by hand)', async () => {
    // B1: effective suspension 40 days ago (approved 35 days ago), effective resumption 30 days ago (approved 25 days ago): days 40 to 31
    // T1: no effective dates: approval 20 days ago, resumption approved 15 days ago: days 20 to 16. A requested suspension 10 days ago is ignored.
    await db.query(`INSERT INTO change_requests (change_code, site_id, region_id, kind, status, approval_date, suspension_start, resumption_date, is_global, requested_by) VALUES
      ('P2-S1', $1, 5, 'suspension', 'approved', cal_today() - 35, cal_today() - 40, NULL, false, $3),
      ('P2-R1', $1, 5, 'resumption', 'applied', cal_today() - 25, NULL, cal_today() - 30, false, $3),
      ('P2-S2', $2, 1, 'suspension', 'approved', cal_today() - 20, NULL, NULL, false, $3),
      ('P2-R2', $2, 1, 'resumption', 'approved', cal_today() - 15, NULL, NULL, false, $3),
      ('P2-S3', $2, 1, 'suspension', 'requested', NULL, cal_today() - 10, NULL, false, $3)`, [fx.site.B1!.id, fx.site.T1!.id, fx.userX]);
    suspB1 = await wdBetween(db, 41, 31);
    suspT1 = await wdBetween(db, 21, 16);
    const dl = (await get(admin)).delay;
    expect(dl.suspended_working_days).toBe(suspB1 + suspT1);
    expect(dl.total_late_working_days).toBe(await wdBetween(db, 30) + await wdBetween(db, 60) - suspB1 - suspT1 + await t2a2());
  });

  it('every uncovered day is unattributed: the R party is a suggestion only, and the scorecard is empty (Q7)', async () => {
    const dl = (await get(admin)).delay;
    expect(dl.items.every((i: J) => i.kind === 'unattributed' && i.party === 'unattributed')).toBe(true);
    expect(dl.items.find((i: J) => i.suggested_party?.name === 'cw_contractor')).toMatchObject({
      late_tasks: 2, late_working_days: await wdBetween(db, 30) + await wdBetween(db, 60) - suspB1 - suspT1, suggested_party: { kind: 'default_type' }, data_gap: false });
    expect(dl.items.find((i: J) => !i.suggested_party)).toMatchObject({ late_tasks: 1, late_working_days: await t2a2(), data_gap: false });
    expect(dl).toMatchObject({ attributed_pct: 0, unattributed_pct: 100, attributed_working_days: 0, scorecard: [] });
  });

  it('a closed late task whose window cannot hold a day is a data gap, with no suggested party (Q181)', async () => {
    // T3 A2: start 5 days ago, closed 4 days ago, 3 working days over the maximum: the rebuilt due day (start + 2) is after the close
    await db.query(`INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, actual_date, approved_date, sla_rule_id, sla_start_date, sla_end_date, sla_elapsed_wd, updated_at)
      SELECT $1, 1, $2, 'approved', 0, 3, cal_today() - 4, cal_today() - 4, r.id, cal_today() - 5, cal_today() - 4, r.max_working_days + 3, now()
      FROM sla_rules r WHERE r.task_def_id = $2 ORDER BY r.id LIMIT 1`, [fx.site.T3!.id, fx.td.A2]);
    const dl = (await get(admin)).delay;
    expect(dl.items.find((i: J) => i.data_gap)).toMatchObject({ kind: 'unattributed', late_tasks: 1, late_working_days: 3, suggested_party: null });
    expect(dl.data_gap_working_days).toBe(3);
    expect(dl.total_late_working_days).toBe(await wdBetween(db, 30) + await wdBetween(db, 60) - suspB1 - suspT1 + await t2a2() + 3);
  });
});

describe('Q182, Q184: a period is proposed, then decided by somebody else', () => {
  const periods = (a: Actor, task: string) => a.api.call('get', `/tasks/${task}/delay-periods`);
  const propose = (a: Actor, task: string, body: J) => a.api.call('post', `/tasks/${task}/delay-periods`).send(body);
  const decide = (a: Actor, task: string, id: string, body: J) => a.api.call('post', `/tasks/${task}/delay-periods/${id}/decision`).send(body);
  let contractorId = '';

  it('L1 proposes (no effect yet) but does not decide; the approval of a contractor period needs its named party', async () => {
    expect((await periods(l1, t1b8)).body).toMatchObject({ can_propose: true, can_decide: false, can_edit: false });
    expect((await periods(reviewer, t1b8)).body).toMatchObject({ can_propose: true, can_decide: true });
    expect((await periods(tripoli, t1b8)).body).toMatchObject({ can_propose: false, can_decide: false });
    expect((await propose(tripoli, t1b8, { from_date: await ago(db, 20), to_date: await ago(db, 11), party: 'gecol', reason: 'not my task' })).status).toBe(403);
    // 20 to 11 days ago: the days 20 to 16 are under the T1 suspension, so the period can cover the days 15 to 11 only
    const r = await propose(l1, t1b8, { from_date: await ago(db, 20), to_date: await ago(db, 11), party: 'contractor', reason: 'crew not on site', evidence: 'site diary p. 12' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ status: 'proposed', evidence: 'site diary p. 12', external_party_id: null, proposed_by: { id: l1.user.id }, decided_by: null, counts: false });
    contractorId = r.body.id;
    const covered = await wdBetween(db, 16, 11);
    let dl = (await get(admin)).delay;
    expect(dl).toMatchObject({ attributed_working_days: 0, proposed_working_days: covered, proposals_count: 1 });
    expect((await decide(l1, t1b8, contractorId, { decision: 'approve', external_party_id: fx.party })).status).toBe(403);
    const noParty = await decide(reviewer, t1b8, contractorId, { decision: 'approve' });
    expect(noParty.status).toBe(422);
    expect(noParty.body.errors[0]).toMatchObject({ path: '/external_party_id', code: 'external_party_required' });
    const ok = await decide(reviewer, t1b8, contractorId, { decision: 'approve', external_party_id: fx.party, note: 'confirmed with the diary' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', external_party_id: fx.party, external_party_name: 'Dash Test Vendor', decided_by: { id: reviewer.user.id }, decision_note: 'confirmed with the diary', counts: true });
    dl = (await get(admin)).delay;
    expect(dl.items.find((i: J) => i.kind === 'period')).toMatchObject({ party: 'Dash Test Vendor', period_party: 'contractor', late_tasks: 1, late_working_days: covered });
    expect(dl.scorecard).toEqual([expect.objectContaining({ party: 'Dash Test Vendor', late_working_days: covered })]);
    expect(dl.attributed_working_days).toBe(covered);
    expect(dl.attributed_pct).toBeCloseTo((covered * 100) / dl.total_late_working_days, 2);
    expect(dl.attributed_pct + dl.unattributed_pct).toBeCloseTo(100, 1);
    expect(dl.proposed_working_days).toBe(0);
    // a day counts once: the shares still add up to the total
    expect(dl.items.reduce((a: number, i: J) => a + i.late_working_days, 0)).toBe(dl.total_late_working_days);
    expect((await decide(reviewer, t1b8, contractorId, { decision: 'reject', note: 'again' })).status).toBe(409);
  });

  it('Q393: a task whose SLA rule is pending_confirmation stays out of the scorecard (its days stay in the total delay and the items); its colour is unchanged', async () => {
    const before = (await get(admin)).delay;
    const covered = before.attributed_working_days as number;
    expect(covered).toBeGreaterThan(0);
    expect(before.scorecard).toEqual([expect.objectContaining({ party: 'Dash Test Vendor', late_working_days: covered })]);
    expect(before).toMatchObject({ scorecard_excluded_working_days: 0, scorecard_excluded_tasks: 0 });
    const colour = (await admin.api.call('get', `/tasks/${t1b8}`)).body.sla;
    const ruleId = (await q<{ id: string }>(db, 'SELECT sla_rule_id AS id FROM task_instances WHERE id = $1', [t1b8]))[0]!.id;
    await db.query('UPDATE sla_rules SET pending_confirmation = true WHERE id = $1', [ruleId]);
    try {
      const dl = (await get(admin)).delay;
      expect(dl.scorecard).toEqual([]);
      expect(dl).toMatchObject({ scorecard_excluded_working_days: covered, scorecard_excluded_tasks: 1 });
      // the days are still late and still attributed: the total, the shares and the items do not move
      expect(dl.total_late_working_days).toBe(before.total_late_working_days);
      expect(dl.attributed_working_days).toBe(covered);
      expect(dl.items.find((i: J) => i.kind === 'period')).toMatchObject({ party: 'Dash Test Vendor', late_working_days: covered });
      // the task still shows the colour it had, and says its rule waits for the owner
      const sla = (await admin.api.call('get', `/tasks/${t1b8}`)).body.sla;
      expect(sla).toMatchObject({ colour: colour.colour, pending_confirmation: true });
    } finally {
      await db.query('UPDATE sla_rules SET pending_confirmation = false WHERE id = $1', [ruleId]);
    }
    const after = (await get(admin)).delay;
    expect(after.scorecard).toEqual(before.scorecard);
    expect(after).toMatchObject({ scorecard_excluded_working_days: 0, scorecard_excluded_tasks: 0 });
  });

  it('a rejection needs a note, has no effect and stays in the history; the proposer may withdraw an open proposal', async () => {
    const r = await propose(l1, t1b8, { from_date: await ago(db, 8), to_date: await ago(db, 5), party: 'hlc', reason: 'no fiber' });
    expect(r.status).toBe(201);
    expect((await decide(reviewer, t1b8, r.body.id, { decision: 'reject' })).status).toBe(422);
    const rej = await decide(reviewer, t1b8, r.body.id, { decision: 'reject', note: 'the link was ready' });
    expect(rej.status).toBe(200);
    expect(rej.body).toMatchObject({ status: 'rejected', decision_note: 'the link was ready', counts: false });
    expect((await reviewer.api.call('post', `/tasks/${t1b8}/delay-periods/${r.body.id}/void`).send({ reason: 'tidy up' })).status).toBe(409);
    const w = await propose(l1, t1b8, { from_date: await ago(db, 3), to_date: await ago(db, 2), party: 'gecol', reason: 'no power' });
    expect(w.status).toBe(201);
    const v = await l1.api.call('post', `/tasks/${t1b8}/delay-periods/${w.body.id}/void`).send({ reason: 'proposed by mistake' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body).toMatchObject({ voided: true, voided_by: { id: l1.user.id } });
    const actions = await q<{ action: string }>(db, `SELECT action FROM audit_log WHERE entity_type = 'task_delay_period' ORDER BY id`);
    expect(actions.map((a) => a.action)).toEqual(['delay_period.proposed', 'delay_period.approved', 'delay_period.proposed', 'delay_period.rejected', 'delay_period.proposed', 'delay_period.voided']);
  });

  it('nobody decides their own proposal, an admin included; another decider may', async () => {
    const r = await propose(reviewer, t1b8, { from_date: await ago(db, 4), to_date: await ago(db, 4), party: 'client', reason: 'site closed by the client' });
    expect(r.status).toBe(201);
    const self = await decide(reviewer, t1b8, r.body.id, { decision: 'approve' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('self_beneficiary');
    expect((await decide(admin, t1b8, r.body.id, { decision: 'approve' })).status).toBe(200);
    const a = await propose(admin, t1b8, { from_date: await ago(db, 1), to_date: await ago(db, 1), party: 'aljeel', reason: 'our own delay' });
    expect((await decide(admin, t1b8, a.body.id, { decision: 'approve' })).status).toBe(403);
  });

  it('an approved contractor period without its party (from before 0059) does not count and is reported', async () => {
    const before = (await get(admin)).delay;
    await db.query(`INSERT INTO task_delay_periods (task_id, site_id, region_id, from_date, to_date, party, reason, created_by, status, decided_by, decided_at, decision_note)
      VALUES ($1, $2, 5, cal_today() - 50, cal_today() - 45, 'contractor', 'legacy period', $3, 'approved', $3, now(), 'recorded with immediate effect before migration 0059 (Q122)')`,
    [b1b8, fx.site.B1!.id, fx.userX]);
    const after = (await get(admin)).delay;
    expect(after.pending_party_count).toBe(1);
    expect(after.attributed_working_days).toBe(before.attributed_working_days);
    expect(after.total_late_working_days).toBe(before.total_late_working_days);
    const list = (await admin.api.call('get', `/tasks/${b1b8}/delay-periods`)).body;
    expect(list.items[0]).toMatchObject({ status: 'approved', counts: false });
  });

  it('the application role cannot write a decision directly, and a decided period is never rewritten', async () => {
    const appDb = new PgClient({ connectionString: process.env.TEST_DATABASE_URL_DASHP2 });
    await appDb.connect();
    try {
      await expect(appDb.query(`UPDATE task_delay_periods SET status = 'approved'`)).rejects.toThrow(/permission denied/);
      await expect(appDb.query(`SELECT delay_period_decide($1, 'approve', NULL, NULL)`, [contractorId])).rejects.toThrow(/sign in first/);
    } finally {
      await appDb.end();
    }
    const full = await superDbDashP2();
    try {
      await expect(full.query(`UPDATE task_delay_periods SET status = 'rejected' WHERE id = $1`, [contractorId])).rejects.toThrow(/never rewritten/);
    } finally {
      await full.end();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------- Q187
describe('Q187: the Excel workbook', () => {
  const download = (a: Actor, qs: string) => a.api.call('get', `${DASH}/export${qs}`).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  const rowsOf = (ws: ExcelJS.Worksheet): unknown[][] => {
    const out: unknown[][] = [];
    ws.eachRow((r) => out.push((r.values as unknown[]).slice(1)));
    return out;
  };

  it('has Project Overview, CW, TE, the detail sheets and About; the CSV stays flat', async () => {
    const res = await download(exporter, '');
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Project Overview', 'CW', 'TE', 'Late tasks', 'Delay attribution', 'Project Status items', 'Regions', 'About']);
    expect(rowsOf(wb.getWorksheet('Project Overview')!)).toContainEqual(['headline', 'sites', 'active', 8]);
    // the CW sheet is the CW view: its pipeline is MS2 to MS4
    const cw = rowsOf(wb.getWorksheet('CW')!).filter((r) => r[0] === 'milestones' && r[2] === 'sites_total').map((r) => String(r[1]).split(' ')[0]);
    expect(cw).toEqual(['MS2', 'MS3', 'MS4']);
    const delay = rowsOf(wb.getWorksheet('Delay attribution')!);
    expect(delay[0]).toEqual(['kind', 'party', 'suggested party (not an attribution)', 'data gap', 'late tasks', 'late working days', 'share %']);
    expect(delay.some((r) => r[0] === 'period' && r[1] === 'Dash Test Vendor')).toBe(true);
    expect(delay.some((r) => r[0] === 'unattributed' && r[3] === 'yes')).toBe(true);
    const ps = rowsOf(wb.getWorksheet('Project Status items')!).find((r) => r[1] === '8.1')!;
    expect(ps.slice(8, 10)).toEqual([40, 50]);
    const about = rowsOf(wb.getWorksheet('About')!);
    expect(about).toContainEqual(['contract version', '0.12.7']);
    expect(wb.getWorksheet('Project Overview')!.pageSetup.orientation).toBe('landscape');
    const audit = await q<{ after: J }>(db, `SELECT after FROM audit_log WHERE action = 'export' AND entity_type = 'dashboard' AND actor_id = $1 ORDER BY id DESC LIMIT 1`, [exporter.user.id]);
    expect(audit[0]!.after.sheets).toHaveLength(8);
    const csv = await download(exporter, '?format=csv');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect((csv.body as Buffer).toString('utf8')).toContain('delay attribution (draft),cw_contractor,"unattributed late working days (suggested party, not attributed)",');
  });
});
