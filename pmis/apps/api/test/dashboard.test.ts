import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixture, ago, q, wdBetween } from './dash-fixture';
import type { Fix } from './dash-fixture';
import { JobsService } from '../src/jobs/jobs.service';
import { makeUser, startApp, superDbDash } from './helpers';
import { actor, plainAdmin } from './wf-helpers';
import type { Actor } from './wf-helpers';

/**
 * The main dashboard on a small data set whose numbers are computed by hand (see dash-fixture.ts for the data and the milestone dates). The whole file runs in
 * its own database (TEST_DATABASE_URL_DASH) because the dashboard counts every site it can see. Dates are "today minus n days" counted by the database, and the
 * working-day figures are compared with the calendar function of the database, so the suite holds on a Friday or a Saturday (weekend days here).
 */
let app: NestExpressApplication;
let db: PgClient;
let fx: Fix;
let admin: Actor;
let tripoli: Actor;
let nobody: Actor;
let exporter: Actor;
let withoutIssues: Actor;

const DASH = '/dashboard';
type J = Record<string, any>;

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_DASH as string });
  db = await superDbDash();
  const x = await makeUser(db, { assigned: true });
  const y = await makeUser(db, { assigned: true });
  await db.query(`UPDATE users SET display_name = 'Owner X' WHERE id = $1`, [x.id]);
  await db.query(`UPDATE users SET display_name = 'Owner Y' WHERE id = $1`, [y.id]);
  fx = await buildFixture(db, x.id, y.id);
  admin = await plainAdmin(app, db, true);
  tripoli = await actor(app, db, { regions: [1], grants: [['dashboard', 'view'], ['issues', 'view']] });
  withoutIssues = await actor(app, db, { regions: [1], grants: [['dashboard', 'view']] });
  exporter = await actor(app, db, { regions: null, grants: [['dashboard', 'view'], ['dashboard', 'export'], ['issues', 'view']] });
  nobody = await actor(app, db, { grants: [['sites', 'view']] });
});

afterAll(async () => {
  await db.end();
  await app.close();
});

const get = async (a: Actor, qs = ''): Promise<J> => {
  const res = await a.api.call('get', `${DASH}${qs}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as J;
};
const node = (d: J, code: string): J => d.pipeline.nodes.find((n: J) => n.code === code);
const stream = (d: J, code: string): J => d.streams.items.find((s: J) => s.code === code);

describe('headline KPIs (admin, all regions, today)', () => {
  it('counts the sites by Overall Status from the dated facts; the cancelled site is left out of every figure', async () => {
    const d = await get(admin);
    expect(d.basis.source).toBe('live');
    expect(d.headline.sites_total).toBe(8);
    expect(d.headline.sites_cancelled).toBe(1);
    // T1 T2 T6 B1 in progress, T3 B3 not started, T4 completed (MS10), B2 on hold (a suspension without a resumption), T5 cancelled
    expect(d.headline.by_overall_status).toEqual({ not_started: 2, in_progress: 4, on_hold: 1, completed: 1, cancelled: 1 });
  });

  it('counts the milestones reached, the plan (baseline due by today) and the difference from it', async () => {
    const d = await get(admin);
    const done = Object.fromEntries(d.headline.milestones.map((m: J) => [m.code, m.done]));
    expect(done).toEqual({ MS1: 6, MS2: 4, MS3: 4, MS4: 4, MS5: 3, MS6: 3, MS7: 2, MS8: 2, MS9: 2, MS10: 1 });
    expect(d.headline.milestones.every((m: J) => m.applicable === 8)).toBe(true);
    const ms1 = d.headline.milestones.find((m: J) => m.code === 'MS1');
    // baselines of MS1 due by today: T1 T2 T3 B1 B2 (5); missing for T4 T6 B3 (3)
    expect(ms1).toMatchObject({ done: 6, done_pct: 75, plan: 5, vs_plan: 1, baseline_missing: 3 });
    expect(d.headline.on_air).toMatchObject({ code: 'MS6', done: 3, applicable: 8, done_pct: 37.5 });
  });

  it('shows the Final Closure KPI apart from Project Status: closed, % closed, pending CW FAC and TE FAC with their age in working days', async () => {
    const f = (await get(admin)).headline.final_closure;
    expect(f).toMatchObject({ sites_total: 2, sites_closed: 1, closed_pct: 50, active_sites: 8, closed_pct_of_active: 12.5 });
    // CW FAC: T6 waits since its DLP ended 20 days ago; T1's DLP ends in 30 days (not due). TE FAC: T6 since 10 days ago.
    expect(f.pending_cw_fac).toMatchObject({ count: 1, not_due: 1, oldest_age_days: await wdBetween(db, 20) });
    expect(f.pending_cw_fac.sites.map((s: J) => s.site_code)).toEqual(['DASH-T6']);
    expect(f.pending_te_fac).toMatchObject({ count: 1, not_due: 0, oldest_age_days: await wdBetween(db, 10) });
  });
});

describe('pipeline for the reference date', () => {
  it('splits every milestone into done, in work, waiting for its gate, blocked, and counts the baseline outcomes', async () => {
    const d = await get(admin);
    // MS1: done 6; T3 and B3 are in work (no gate before MS1); overdue open: T3 (baseline 3 days ago); achieved late: T1 (62 -> 60) and B1 (91 -> 90); on time: T2, B2
    expect(node(d, 'MS1')).toMatchObject({ sites_total: 8, completed: 6, in_progress: 2, not_started: 0, blocked: 0, overdue_open: 1, achieved_late: 2, on_time: 2, late: 1 });
    // MS5: done T4 T6 B1; open and in work: T1 (MS4 done) - blocked by its gate G5; waiting: T2 T3 B2 B3 (earlier milestones open) and T6? no: T6 is done
    expect(node(d, 'MS5')).toMatchObject({ completed: 3, in_progress: 0, blocked: 1, not_started: 4 });
    expect(node(d, 'MS7')).toMatchObject({ completed: 2, blocked: 1 }); // B1 waits at G7
    expect(node(d, 'MS10')).toMatchObject({ completed: 1, in_progress: 1, not_started: 6 }); // T6 is in work, the others wait
  });

  it('measures the delay in working days against the baseline with the calendar of the database', async () => {
    const d = await get(admin);
    const late = [await wdBetween(db, 62, 60), await wdBetween(db, 91, 90)];
    expect(node(d, 'MS1').avg_delay_wd).toBeCloseTo(late.reduce((a, b) => a + b, 0) / 2, 1);
  });

  it('names the gate of each milestone and the stream it belongs to', async () => {
    const d = await get(admin);
    expect(node(d, 'MS5')).toMatchObject({ stream_code: 'TE', gate: { code: 'G5' } });
    expect(node(d, 'MS1').gate).toBeNull();
  });
});

describe('streams (Q37, Q41)', () => {
  it('counts the sites by status in each stream, with a region breakdown, and Dismantle as a fifth stream', async () => {
    const d = await get(admin);
    expect(d.streams.items.map((s: J) => s.code)).toEqual(['DESIGN_ACQ', 'CW', 'TE', 'CLOSURE', 'DISMANTLE']);
    expect(stream(d, 'DESIGN_ACQ').counts).toMatchObject({ done: 6, in_progress: 2, na: 0 });
    expect(stream(d, 'CW').counts).toMatchObject({ done: 4, in_progress: 2, not_due: 2 });
    expect(stream(d, 'TE').counts).toMatchObject({ done: 2, in_progress: 2, not_due: 4 });
    expect(stream(d, 'CLOSURE').counts).toMatchObject({ done: 1, in_progress: 1, not_due: 6 });
    expect(stream(d, 'DISMANTLE').counts).toMatchObject({ done: 1, not_started: 1, na: 6 });
    const cw = stream(d, 'CW').by_region;
    expect(cw.find((r: J) => r.region_id === 1)).toMatchObject({ done: 3, in_progress: 1, not_due: 1 }); // T1 T4 T6 done; T2 in progress; T3 not due
    expect(cw.find((r: J) => r.region_id === 5)).toMatchObject({ done: 1, in_progress: 1, not_due: 1 }); // B1; B2; B3
    expect(stream(d, 'TE').counts.on_hold).toBe(1); // B2 is on hold and its TE work has not started
  });
});

describe('SLA', () => {
  it('counts open tasks on time, at risk and late per stage, and completed ones within the maximum or over it', async () => {
    const d = await get(admin);
    const stage = (c: string): J => d.sla.by_stage.find((s: J) => s.stage_code === c);
    expect(stage('MS1')).toMatchObject({ completed_on_time: 2, completed_late: 1 }); // A2 at T1 B1 within, at T2 over
    expect(stage('MS3')).toMatchObject({ open_late: 2 }); // B8 at T1 and B1
    expect(stage('MS5')).toMatchObject({ open_at_risk: 1 }); // D5 at T1
    expect(stage('MS6')).toMatchObject({ open_on_time: 2 }); // D7 at T2 and B1
    expect(d.sla.totals).toMatchObject({ open_late: 2, open_at_risk: 1, open_on_time: 2, completed_on_time: 2, completed_late: 1 });
  });

  it('lists the top late tasks, the most overdue first, with the working days late', async () => {
    const top = (await get(admin)).sla.top_late;
    expect(top.map((t: J) => `${t.site_code}/${t.task_code}`)).toEqual(['DASH-B1/B8', 'DASH-T1/B8']);
    expect(top[0].days_late_wd).toBe(await wdBetween(db, 60));
    expect(top[1].days_late_wd).toBe(await wdBetween(db, 30));
  });
});

describe('gates', () => {
  it('lists the blocked gates with the reasons the calculation layer gives', async () => {
    const g = (await get(admin)).gates;
    expect(g).toMatchObject({ available: true, blocked_total: 2 });
    const t1 = g.items.find((i: J) => i.site_code === 'DASH-T1');
    expect(t1).toMatchObject({ gate_code: 'G5', to_code: 'MS5', region_id: 1 });
    expect(t1.reasons.map((r: J) => r.ref_code)).toContain('Access - TE');
  });
});

describe('issues (Q36)', () => {
  it('counts issues for the owner bars and totals, and sites for "sites with an open issue"; the age is in working days from the raised date', async () => {
    const i = (await get(admin)).issues;
    expect(i).toMatchObject({ available: true, open_total: 4, sites_with_open_issue: 3, blocking_total: 1 });
    const x = i.by_owner.find((o: J) => o.owner_name === 'Owner X');
    expect(x).toMatchObject({ count: 2, sites: 1, oldest_age_wd: await wdBetween(db, 20) });
    expect(i.by_owner.find((o: J) => o.owner_name === 'Owner Y')).toMatchObject({ count: 1 });
    expect(i.by_owner.find((o: J) => o.owner_name === 'Dash Test Vendor')).toMatchObject({ count: 1, owner_kind: 'party' });
    expect(i.oldest_age_wd).toBe(await wdBetween(db, 40));
    expect(i.age_buckets.reduce((a: number, b: J) => a + b.count, 0)).toBe(4);
  });

  it('leaves the issues section out for a caller without the Issue Log module', async () => {
    expect((await get(withoutIssues)).issues).toBeNull();
  });
});

describe('Project Status weights (rules.md section 6)', () => {
  it('computes the weighted progress with the active set; items with no data are dropped and their weight redistributed', async () => {
    const ps = (await get(admin)).headline.project_status;
    // measured: 1.1 (3/3), 4.7 (4/8), 4.8 (3/3), 5.2 (0/1), 6.2 (0/2), 6.5 (3/8), 7.5 (2/8), 7.6 (2/8), 8.2 (2/8)
    // A1 100 · A4 (15*.5+5*1)/20 = 62.5 · A5 0 · A6 (35*.375)/55 = 23.8636 · A7 25 · A8 25 -> (12+15.625+0+2.8636+3.25+1.25)/87
    expect(ps.progress_pct).toBeCloseTo(40.217, 2);
    const act = Object.fromEntries(ps.activities.map((a: J) => [a.code, a.progress_pct]));
    expect(act.A1).toBeCloseTo(100, 2);
    expect(act.A4).toBeCloseTo(62.5, 2);
    expect(act.A5).toBeCloseTo(0, 2);
    expect(act.A6).toBeCloseTo(23.864, 2);
    expect(act.A7).toBeCloseTo(25, 2);
    expect(act.A8).toBeCloseTo(25, 2);
    expect(ps.activities.find((a: J) => a.code === 'A2').measured).toBe(false);
    expect(ps.planned_pct).toBeNull(); // not every measured item has plan dates
    expect(ps.spi).toBeNull();
    expect(ps.plan_coverage_pct).toBeLessThan(100);
    const items = ps.activities.flatMap((a: J) => a.items);
    expect(items).toHaveLength(45);
    expect(items.find((i: J) => i.code === '1.3')).toMatchObject({ measured: false, reason: 'no_data' });
    expect(items.find((i: J) => i.code === '3.10')).toMatchObject({ measured: false, reason: 'not_weighted' });
    expect(items.find((i: J) => i.code === '2.1')).toMatchObject({ measured: false, reason: 'not_applicable' });
  });

  it('GET /project-status gives the same figure, groups by region and by site, and names the weight set it used', async () => {
    const r = await admin.api.call('get', '/project-status');
    expect(r.status).toBe(200);
    expect(r.body.progress_pct).toBeCloseTo(40.217, 2);
    expect(r.body.weight_set).toMatchObject({ code: 'project_status', version: 1, is_active: true });
    const by = await admin.api.call('get', '/project-status?group_by=region');
    expect(by.body.rows.map((x: J) => x.key)).toEqual(['1', '5']);
    const t = by.body.rows.find((x: J) => x.key === '1');
    expect(t.progress_pct).toBeCloseTo(45.695, 2); // computed by hand: (12 + 17.5 + 0 + 3.0545 + 5.2 + 2) / 87
    const one = await admin.api.call('get', `/project-status?site_id=${fx.site.T4!.id}`);
    expect(one.body.scope).toEqual({ kind: 'site', site_id: fx.site.T4!.id });
    expect(one.body.sites_in_scope).toBe(1);
    const sites = await admin.api.call('get', '/project-status?group_by=site');
    expect(sites.body.rows.length).toBe(8);
  });

  it('refuses a weight set that is not a published Project Status set, and both selectors together', async () => {
    const hi = (await q<{ id: string }>(db, `SELECT id FROM weight_sets WHERE code = 'health_index'`))[0]!.id;
    expect((await admin.api.call('get', `/project-status?weight_set_id=${hi}`)).status).toBe(422);
    expect((await admin.api.call('get', '/project-status?weight_set_version=99')).status).toBe(422);
    const ps = (await q<{ id: string }>(db, `SELECT id FROM weight_sets WHERE code = 'project_status'`))[0]!.id;
    expect((await admin.api.call('get', `/project-status?weight_set_id=${ps}&weight_set_version=1`)).status).toBe(422);
    expect((await admin.api.call('get', `/project-status?weight_set_id=${ps}`)).status).toBe(200);
  });
});

describe('health index (draft, Q35 bands)', () => {
  it('computes the six factors, leaves out a factor with no data and redistributes its weight', async () => {
    const h = (await get(admin)).health;
    expect(h.draft).toBe(true);
    const c = (code: string): J => h.components.find((x: J) => x.code === code);
    expect(c('B').value).toBeCloseTo(57.143, 2); // 4 of the 7 achieved milestones with a baseline were on time
    expect(c('S').value).toBeCloseTo(66.667, 2); // 2 of 3 completed SLA clocks within the maximum
    const approved = (await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM task_instances t JOIN sites s ON s.id = t.site_id WHERE t.state = 'approved' AND s.overall_status <> 'cancelled'`))[0]!.n;
    expect(c('F').value).toBeCloseTo((100 * (approved - 1)) / approved, 2); // one approval was returned once
    expect(c('I').value).toBeCloseTo(75, 2); // T1 (an issue on a gate) and B1 (a Major snag) of 8 sites
    expect(c('D')).toMatchObject({ value: null, excluded: true, contribution: 0 });
    const used = h.components.filter((x: J) => !x.excluded);
    const expected = used.reduce((a: number, x: J) => a + x.weight * x.value, 0) / used.reduce((a: number, x: J) => a + x.weight, 0);
    expect(h.score).toBeCloseTo(expected, 1);
    expect(used.reduce((a: number, x: J) => a + x.contribution, 0)).toBeCloseTo(h.score, 0);
  });

  it('maps the score to the bands of the setting dashboard.health_bands: green from 85, amber from 70, red below', async () => {
    const score = (await get(admin)).health.score as number;
    const set = (b: object) => db.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'dashboard.health_bands'`, [JSON.stringify(b)]);
    try {
      expect((await get(admin)).health.bands).toEqual({ green: 85, amber: 70 }); // the default
      await set({ green: Math.floor(score) - 1, amber: 0 });
      expect((await get(admin)).health.band).toBe('green');
      await set({ green: Math.floor(score) + 10, amber: Math.floor(score) - 1 });
      expect((await get(admin)).health.band).toBe('amber');
      await set({ green: 100, amber: Math.floor(score) + 1 });
      expect((await get(admin)).health.band).toBe('red');
      await set({ green: score, amber: 0 });
      expect((await get(admin)).health.band).toBe('green'); // the boundary belongs to the higher band
    } finally {
      await set({ green: 85, amber: 70 });
    }
  });

  it('gives a score and a band per region', async () => {
    const h = (await get(admin)).health;
    expect(h.by_region.map((r: J) => r.region_id)).toEqual([1, 5]);
    expect(h.by_region.every((r: J) => ['green', 'amber', 'red'].includes(r.band))).toBe(true);
  });
});

describe('delay attribution (draft)', () => {
  it('gives overdue working days per responsible party; the shares add up to 100 and there are no attribution periods yet', async () => {
    const dl = (await get(admin)).delay;
    expect(dl.draft).toBe(true);
    expect(dl.periods_supported).toBe(false);
    expect(dl.total_late_working_days).toBeGreaterThan(0);
    expect(dl.items.reduce((a: number, i: J) => a + i.late_working_days, 0)).toBe(dl.total_late_working_days);
    expect(dl.items.reduce((a: number, i: J) => a + i.share_pct, 0)).toBeGreaterThan(99.9);
    // the late B8 tasks have the contractor type as their default party, the late A2 clock at T2 has none
    expect(dl.items.map((i: J) => i.party)).toContain('cw_contractor');
  });
});

describe('visibility: regions and modules (B3, VI-04)', () => {
  it('a Tripoli user sees the Tripoli counts only, never the Benghazi ones', async () => {
    const d = await get(tripoli);
    expect(d.headline.sites_total).toBe(5);
    expect(d.headline.by_overall_status).toEqual({ not_started: 1, in_progress: 3, on_hold: 0, completed: 1, cancelled: 1 });
    expect(d.headline.milestones.find((m: J) => m.code === 'MS1').done).toBe(4);
    expect(d.regions.items.map((r: J) => r.region_id)).toEqual([1]);
    expect(d.filters.regions.map((r: J) => r.id)).toEqual([1]);
    expect(d.meta.scope_regions).toEqual([1]);
    expect(stream(d, 'CW').by_region.map((r: J) => r.region_id)).toEqual([1]);
    expect(d.gates.blocked_total).toBe(1); // B1's gate is in Benghazi
    expect(d.gates.items.map((i: J) => i.site_code)).toEqual(['DASH-T1']);
    expect(d.issues).toMatchObject({ open_total: 3, sites_with_open_issue: 2 });
    expect(d.issues.by_owner.find((o: J) => o.owner_name === 'Owner Y')).toBeUndefined();
    expect(d.sla.top_late.map((t: J) => t.site_code)).toEqual(['DASH-T1']);
    expect(JSON.stringify(d)).not.toContain('DASH-B');
    expect(d.headline.final_closure.sites_total).toBe(2);
  });

  it('asking for another region gives an empty view, not the other region', async () => {
    const d = await get(tripoli, '?region_id=5');
    expect(d.headline.sites_total).toBe(0);
    expect(d.regions.items).toEqual([]);
    expect(JSON.stringify(d)).not.toContain('DASH-B');
  });

  it('computes the Project Status of the Tripoli sites only, and says that the central items are hidden', async () => {
    const d = await get(tripoli);
    expect(d.headline.project_status.progress_pct).toBeCloseTo(45.695, 2);
    expect(d.meta.project_wide).toBe(false);
    expect(d.meta.central_items_hidden).toBe(14); // 1.3 1.5 3.2-3.9 6.1 6.6 7.7 8.1 (3.10 has weight 0)
    const all = await get(admin);
    expect(all.meta.project_wide).toBe(true);
    expect(all.meta.central_items_hidden).toBe(0);
    const ps = await tripoli.api.call('get', '/project-status');
    expect(ps.body.progress_pct).toBeCloseTo(45.695, 2);
    expect((await tripoli.api.call('get', `/project-status?site_id=${fx.site.B1!.id}`)).status).toBe(404); // not visible
  });

  it('refuses a caller without the dashboard module, and an anonymous one', async () => {
    const res = await nobody.api.call('get', DASH);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('module_forbidden');
    expect((await nobody.api.call('get', '/project-status')).status).toBe(403);
    expect((await nobody.api.call('get', '/project-status/snapshots')).status).toBe(403);
    expect((await nobody.api.call('get', `${DASH}/export`)).status).toBe(403);
    const anon = await exporter.api.raw('get', DASH).set('Cookie', 'pmis_session=bad');
    expect(anon.status).toBe(401);
  });
});

describe('filters', () => {
  it('filters by scenario, cluster and region, and refuses unknown values', async () => {
    expect((await get(admin, '?scenario=expansion')).headline.sites_total).toBe(1); // T2
    expect((await get(admin, '?cluster_code=DASH-CL1')).headline.sites_total).toBe(2); // T1 T2
    expect((await get(admin, '?region_id=5')).headline.sites_total).toBe(3);
    expect((await get(admin, '?region_id=1&scenario=new_build')).headline.sites_total).toBe(4); // T1 T3 T4 T6
    expect((await admin.api.call('get', `${DASH}?scenario=weird`)).status).toBe(422);
    expect((await admin.api.call('get', `${DASH}?region_id=9`)).status).toBe(422);
    expect((await admin.api.call('get', `${DASH}?stream=NOPE_STREAM`)).status).toBe(422);
    expect((await admin.api.call('get', `${DASH}?exclude_overrides=maybe`)).status).toBe(422);
  });

  it('the stream filter keeps the sites the stream applies to; Dismantle keeps the sites with a Dismantle part', async () => {
    const d = await get(admin, '?stream=DISMANTLE');
    expect(d.headline.sites_total).toBe(2); // T4 and B1
    expect((await get(admin, '?stream=CW')).headline.sites_total).toBe(8);
    const cw = await get(admin, '?stream=CW');
    expect(cw.pipeline.nodes.map((n: J) => n.code)).toEqual(['MS2', 'MS3', 'MS4']);
    expect(cw.sla.by_stage.every((s: J) => s.stream_code === 'CW')).toBe(true);
  });

  it('offers the filter lists of the caller', async () => {
    const f = (await get(admin)).filters;
    expect(f.scenarios).toEqual(['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation']);
    expect(f.clusters).toContain('DASH-CL1');
    expect(f.streams.map((s: J) => s.code)).toEqual(['DESIGN_ACQ', 'CW', 'TE', 'CLOSURE', 'DISMANTLE']);
  });
});

describe('reference date (Q34)', () => {
  it('computes a past date from the dated facts and says so; a future date or a bad one is refused', async () => {
    const d25 = await ago(db, 25);
    const d = await get(admin, `?ref_date=${d25}`);
    expect(d.basis).toMatchObject({ source: 'as_of_computed', ref_date: d25 });
    expect(d.basis.note).toMatch(/computed as of the date/);
    // 25 days ago: T1 4 milestones done · T2 0 (its MS1 is 20 days old) · T4 8 · T6 7 · B1 6 · B2 0 · T3 B3 0
    const done = Object.fromEntries(d.headline.milestones.map((m: J) => [m.code, m.done]));
    expect(done).toEqual({ MS1: 4, MS2: 4, MS3: 4, MS4: 4, MS5: 3, MS6: 3, MS7: 2, MS8: 1, MS9: 0, MS10: 0 });
    expect(d.headline.by_overall_status).toEqual({ not_started: 4, in_progress: 4, on_hold: 0, completed: 0, cancelled: 1 });
    expect(d.gates.available).toBe(false);
    expect(d.headline.final_closure).toMatchObject({ sites_total: 0, sites_closed: 0 });
  });

  it('today is the default and shows the live facts; the same request with ref_date = today is the same view', async () => {
    const a = await get(admin);
    const b = await get(admin, `?ref_date=${fx.today}`);
    expect(b.basis.source).toBe('live');
    expect(b.headline.by_overall_status).toEqual(a.headline.by_overall_status);
  });

  it('refuses a date in the future and a date that is not a date', async () => {
    const future = (await q<{ d: string }>(db, `SELECT (cal_today() + 3)::text AS d`))[0]!.d;
    const res = await admin.api.call('get', `${DASH}?ref_date=${future}`);
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ path: '/ref_date', code: 'in_future' });
    expect((await admin.api.call('get', `${DASH}?ref_date=2026-13-45`)).status).toBe(422);
    expect((await admin.api.call('get', `${DASH}?ref_date=yesterday`)).status).toBe(422);
  });
});

describe('weekly snapshots', () => {
  it('stores one row per site and one per region and for the project; a past date with a snapshot is read from it and does not move when the facts change', async () => {
    const d25 = await ago(db, 25);
    const n = (await q<{ n: number }>(db, 'SELECT dash_snapshot_take($1::date) AS n', [d25]))[0]!.n;
    expect(n).toBe(9); // eight active sites and the cancelled one
    expect((await q<{ n: number }>(db, 'SELECT count(*)::int AS n FROM progress_snapshots WHERE snapshot_date = $1', [d25]))[0]!.n).toBe(8); // the project and 7 regions
    // never rewritten: a second take adds nothing
    expect((await q<{ n: number }>(db, 'SELECT dash_snapshot_take($1::date) AS n', [d25]))[0]!.n).toBe(0);
    const before = await get(admin, `?ref_date=${d25}`);
    expect(before.basis).toMatchObject({ source: 'snapshot', snapshot_date: d25 });
    // the facts change afterwards: T2's first milestone is moved back to 40 days ago
    await db.query(`UPDATE task_instances SET actual_date = cal_today() - 40, approved_date = cal_today() - 40 WHERE site_id = $1 AND task_def_id = $2`, [fx.site.T2!.id, fx.td.MS1]);
    const after = await get(admin, `?ref_date=${d25}`);
    expect(after.basis.source).toBe('snapshot');
    expect(after.headline.milestones.find((m: J) => m.code === 'MS1').done).toBe(before.headline.milestones.find((m: J) => m.code === 'MS1').done);
    expect(after.headline.by_overall_status).toEqual(before.headline.by_overall_status);
    expect(after.headline.project_status.progress_pct).toBeCloseTo(before.headline.project_status.progress_pct, 3);
    // a date without a snapshot is computed from the facts as they are now
    const other = await get(admin, `?ref_date=${await ago(db, 26)}`);
    expect(other.basis.source).toBe('as_of_computed');
    expect(other.headline.milestones.find((m: J) => m.code === 'MS1').done).toBe(5); // T2 is now done before then
    expect(before.basis.snapshot_dates).toContain(d25);
    await db.query(`UPDATE task_instances SET actual_date = cal_today() - 20, approved_date = cal_today() - 20 WHERE site_id = $1 AND task_def_id = $2`, [fx.site.T2!.id, fx.td.MS1]);
  });

  it('is final: no update, and the application role cannot write the snapshot tables', async () => {
    const full = await superDbDash(); // a connection with the triggers on (the fixture connection has them off)
    try {
      await expect(full.query(`UPDATE site_snapshots SET overall_status = 'x'`)).rejects.toThrow(/never rewritten/);
      await expect(full.query(`UPDATE progress_snapshots SET actual_pct = 1`)).rejects.toThrow(/never rewritten/);
    } finally {
      await full.end();
    }
    const appDb = new PgClient({ connectionString: process.env.TEST_DATABASE_URL_DASH });
    await appDb.connect();
    try {
      await expect(appDb.query(`INSERT INTO site_snapshots (snapshot_date, site_id, region_id, overall_status, ms, streams, items) SELECT cal_today(), id, region_id, 'x', '{}', '{}', '{}' FROM sites LIMIT 1`)).rejects.toThrow(/permission denied/);
      await expect(appDb.query(`DELETE FROM progress_snapshots`)).rejects.toThrow(/permission denied/);
      await expect(appDb.query(`SELECT dash_snapshot_take(cal_today())`)).rejects.toThrow(/permission denied/);
    } finally {
      await appDb.end();
    }
  });

  it('lists the saved Project Status rows: the project row only for an all-regions caller, region rows for the regions of a regional caller', async () => {
    const all = await admin.api.call('get', '/project-status/snapshots?limit=200');
    expect(all.status).toBe(200);
    expect(all.body.items.some((i: J) => i.scope === 'project')).toBe(true);
    expect(all.body.items.some((i: J) => i.scope === 'region' && i.region_id === 5)).toBe(true);
    expect(all.body.items[0].weight_set).toMatchObject({ code: 'project_status' });
    const mine = await tripoli.api.call('get', '/project-status/snapshots?limit=200');
    expect(mine.status).toBe(200);
    expect(mine.body.items.length).toBeGreaterThan(0);
    expect(mine.body.items.every((i: J) => i.scope === 'region' && i.region_id === 1)).toBe(true);
    expect((await admin.api.call('get', '/project-status/snapshots?region_id=1&from=2020-01-01&to=2099-01-01')).body.items.every((i: J) => i.region_id === 1)).toBe(true);
    expect((await admin.api.call('get', '/project-status/snapshots?from=nope')).status).toBe(422);
    const page = await admin.api.call('get', '/project-status/snapshots?limit=1');
    expect(page.body.page.next_cursor).toBeTruthy();
  });

  it('the daily job takes the weekly snapshot once, then waits for the next week', async () => {
    const jobs = app.get(JobsService);
    const first = await jobs.runOnce();
    expect(first).not.toBeNull();
    // the last snapshot (25 days ago) is more than 7 days old, so this run takes today's
    expect(first!.snapshots).toBe(9);
    expect((await q<{ n: number }>(db, 'SELECT count(*)::int AS n FROM site_snapshots WHERE snapshot_date = cal_today()'))[0]!.n).toBe(9);
    const second = await jobs.runOnce();
    expect(second!.snapshots).toBeUndefined();
    expect((await q<{ n: number }>(db, 'SELECT count(*)::int AS n FROM progress_snapshots WHERE snapshot_date = cal_today()'))[0]!.n).toBe(8);
  });
});

describe('export of the current view', () => {
  it('downloads the view as CSV for a caller with the export right on the dashboard, and audits it', async () => {
    const res = await exporter.api.call('get', `${DASH}/export?region_id=1`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/GSDN_Dashboard_\d{4}-\d{2}-\d{2}\.csv/);
    const body = (res.body as Buffer).toString('utf8');
    expect(body.charCodeAt(0)).toBe(0xfeff);
    expect(body).toContain('section,item,metric,value');
    expect(body).toContain('headline,sites,active,5');
    expect(body).not.toContain('DASH-B');
    const audit = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'export' AND entity_type = 'dashboard' AND actor_id = $1`, [exporter.user.id]);
    expect(audit[0]!.n).toBe(1);
  });

  it('refuses the export to a caller who may only view', async () => {
    const res = await tripoli.api.call('get', `${DASH}/export`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('action_forbidden');
  });
});

describe('the database', () => {
  it('the dashboard functions are not callable by the application role except the entry points, and read-only for it', async () => {
    const appDb = new PgClient({ connectionString: process.env.TEST_DATABASE_URL_DASH });
    await appDb.connect();
    try {
      await expect(appDb.query('SELECT dash_core(cal_today(), NULL, NULL, NULL, NULL, NULL, true, NULL, ARRAY[\'headline\'], NULL, \'none\', NULL, true)')).rejects.toThrow(/permission denied/);
      await expect(appDb.query('SELECT dash_build_facts(cal_today(), NULL, NULL, NULL, NULL)')).rejects.toThrow(/permission denied/);
      // a session that is not a user gets nothing from the entry point
      await appDb.query("SELECT set_config('app.region_ids', '*', false)");
      await expect(appDb.query('SELECT dash_overview(NULL, NULL, NULL, NULL, NULL, true)')).rejects.toThrow(/sign in first/);
      // a forged region setting does not widen a user's regions: the scope is derived from the user's own grants
      await appDb.query('SELECT set_config($1, $2, false)', ['app.user_id', tripoli.user.id]);
      const r = await appDb.query(`SELECT dash_overview(NULL, NULL, NULL, NULL, NULL, true) -> 'headline' ->> 'sites_total' AS n`);
      expect(r.rows[0].n).toBe('5');
    } finally {
      await appDb.end();
    }
  });
});
