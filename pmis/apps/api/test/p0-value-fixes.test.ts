import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { actor, makeSite, Site } from './wf-helpers';

/**
 * Migration 0119 (contract 0.15.33): the P0 value fixes of the read-only audit of 2026-11-17. Synthetic sites only.
 *   - SITE 360 BW (GECOL Status), AJ / AK (contractor of the first CW, Tower Erection or Site Adaption order, rejected ones left out), R (As-Built configuration)
 *   - the grid status filter is `status`
 *   - GET /sites dashboard_status, milestone_reached and ref_date: the list a dashboard card opens has the card's count
 */
const TAG = `P0${randomBytes(3).toString('hex').toUpperCase()}`;
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

const site = (region = 1, over: { status?: string; cluster?: string; scenario?: string } = {}): Promise<Site> => makeSite(db, region, { prefix: TAG, ...over });
const moduleOf = async (key: string): Promise<string> => (await db.query(`SELECT module_key FROM register_definitions WHERE register_key = $1`, [key])).rows[0].module_key as string;
const rowValues = async (api: Awaited<ReturnType<typeof actor>>['api'], codes: string[]): Promise<Map<string, Record<string, string | null>>> => {
  const res = await api.call('get', `/site360/master/rows?site_code=${codes.join(',')}&limit=200`);
  expect(res.status).toBe(200);
  return new Map(res.body.rows.map((r: { site_code: string; values: Record<string, string | null> }) => [r.site_code, r.values]));
};

describe('SITE 360 BW GECOL Status: the workbook formula over the GECOL scope and the approved GECOL record', () => {
  it('shows N/A for a site whose GECOL scope is N/A, Done with a power-on date, Pending without one or without a record, and ignores the old status column', async () => {
    const na = await site();
    await db.query(`UPDATE sites SET scope_gecol_power = 'na' WHERE id = $1`, [na.id]);
    await db.query(`INSERT INTO gecol_records (site_id, region_id, status) VALUES ($1, 1, 'energised')`, [na.id]);   // the unwritten column is not read
    const done = await site();
    await db.query(`UPDATE sites SET scope_gecol_power = 'yes' WHERE id = $1`, [done.id]);
    await db.query(`INSERT INTO gecol_records (site_id, region_id, power_on_date) VALUES ($1, 1, DATE '2026-05-04')`, [done.id]);
    const noPower = await site();
    await db.query(`UPDATE sites SET scope_gecol_power = 'yes' WHERE id = $1`, [noPower.id]);
    await db.query(`INSERT INTO gecol_records (site_id, region_id, installation_finish) VALUES ($1, 1, DATE '2026-05-01')`, [noPower.id]);
    const noRecord = await site();
    await db.query(`UPDATE sites SET scope_gecol_power = 'yes' WHERE id = $1`, [noRecord.id]);
    const a = await actor(app, db, { regions: [1], grants: [['sites', 'view'], [await moduleOf('gecol'), 'view'], [await moduleOf('hlc'), 'view']] });
    const v = await rowValues(a.api, [na.code, done.code, noPower.code, noRecord.code]);
    expect(v.get(na.code)!['75']).toBe('N/A');
    expect(v.get(done.code)!['75']).toBe('Done');
    expect(v.get(noPower.code)!['75']).toBe('Pending');
    expect(v.get(noRecord.code)!['75']).toBe('Pending');
    // GECOL Power and HLC Fiber stay apart: the GECOL record says nothing about BX
    await db.query(`UPDATE sites SET scope_hlc_fiber = 'yes' WHERE id = $1`, [done.id]);
    expect((await rowValues(a.api, [done.code])).get(done.code)!['76']).toBe('Pending');
    // a user without the GECOL register view sees no value
    const blind = await actor(app, db, { regions: [1], grants: [['sites', 'view']] });
    expect((await rowValues(blind.api, [done.code])).get(done.code)!['75']).toBeNull();
  });
});

describe('SITE 360 AJ / AK: the contractor of the first CW, Tower Erection or Site Adaption order that is not cancelled or rejected', () => {
  const party = async (name: string): Promise<string> => (await db.query(`INSERT INTO external_parties (name, type, is_active) VALUES ($1, 'cw_contractor', true) RETURNING id`, [name])).rows[0].id as string;

  it('reads a Tower Erection order and a Site Adaption order, leaves out a rejected one and the scopes the workbook excludes', async () => {
    const te = await site();
    const sa = await site();
    const name = `${TAG}-CON-${randomBytes(2).toString('hex')}`;
    const teParty = await party(`${name}-TE`);
    const team = (await db.query(`INSERT INTO external_teams (party_id, name) VALUES ($1, $2) RETURNING id`, [teParty, `${name}-TE team`])).rows[0].id as string;
    const rejected = await party(`${name}-REJ`);
    const install = await party(`${name}-TEI`);
    const saParty = await party(`${name}-SA`);
    // te: an earlier rejected Site Adaption order and an earlier TE Installation order do not count; the Tower Erection order does
    await db.query(`INSERT INTO procurement_records (site_id, region_id, scope, order_status, party_id, po_wo_date) VALUES ($1, 1, 'Site Adaption', 'Rejected', $2, DATE '2026-01-02')`, [te.id, rejected]);
    await db.query(`INSERT INTO procurement_records (site_id, region_id, scope, order_status, party_id, po_wo_date) VALUES ($1, 1, 'TE Installation', 'Active', $2, DATE '2026-01-03')`, [te.id, install]);
    await db.query(`INSERT INTO procurement_records (site_id, region_id, scope, order_status, party_id, team_id, po_wo_date) VALUES ($1, 1, 'Tower Erection', 'Active', $2, $3, DATE '2026-02-01')`, [te.id, teParty, team]);
    // sa: a cancelled CW order does not count; the Site Adaption order does
    await db.query(`INSERT INTO procurement_records (site_id, region_id, scope, order_status, party_id, po_wo_date) VALUES ($1, 1, 'CW', 'Cancelled', $2, DATE '2026-01-02')`, [sa.id, rejected]);
    await db.query(`INSERT INTO procurement_records (site_id, region_id, scope, order_status, party_id, pr_date) VALUES ($1, 1, 'Site Adaption', 'Active', $2, DATE '2026-02-10')`, [sa.id, saParty]);
    const a = await actor(app, db, { regions: [1], grants: [['sites', 'view'], [await moduleOf('procurement'), 'view']] });
    const v = await rowValues(a.api, [te.code, sa.code]);
    expect(v.get(te.code)!['36']).toBe(`${name}-TE`);
    expect(v.get(te.code)!['37']).toBe(`${name}-TE team`);
    expect(v.get(sa.code)!['36']).toBe(`${name}-SA`);
    // the contractor filter reads the same column
    const hit = await a.api.call('get', `/site360/master/rows?site_code=${te.code},${sa.code}&contractor=${encodeURIComponent(`${name}-TE`)}`);
    expect(hit.body.filtered).toBe(1);
    const miss = await a.api.call('get', `/site360/master/rows?site_code=${te.code},${sa.code}&contractor=${encodeURIComponent(`${name}-REJ`)}`);
    expect(miss.body.filtered).toBe(0);
  });

  it('gives no contractor when the only order is rejected', async () => {
    const s = await site();
    await db.query(`INSERT INTO procurement_records (site_id, region_id, scope, order_status, party_id) VALUES ($1, 1, 'CW', 'Rejected', $2)`, [s.id, await party(`${TAG}-ONLYREJ`)]);
    const a = await actor(app, db, { regions: [1], grants: [['sites', 'view'], [await moduleOf('procurement'), 'view']] });
    expect((await rowValues(a.api, [s.code])).get(s.code)!['36']).toBeNull();
  });
});

describe('SITE 360 R Configuration: the configuration of the approved As-Built TE part', () => {
  it('reads it from the approved TE part in force, not from sites.config_summary, and stays empty without one', async () => {
    const s = await site();
    const empty = await site();
    await db.query(`UPDATE sites SET config_summary = 'stale value' WHERE id = ANY($1::uuid[])`, [[s.id, empty.id]]);
    await db.query('SET session_replication_role = replica');
    try {
      await db.query(
        `INSERT INTO register_records (entity_id, version_no, register_key, record_type, site_id, region_id, state, is_current, data, approved_at, current_level)
         VALUES (gen_random_uuid(), 1, 'as_built', 'te_part', $1, 1, 'approved', true, '{"configuration": "WL+MW+IP"}'::jsonb, now(), 3),
                (gen_random_uuid(), 1, 'as_built', 'te_part', $2, 1, 'entry', false, '{"configuration": "draft only"}'::jsonb, NULL, 1)`, [s.id, empty.id]);
    } finally {
      await db.query('SET session_replication_role = origin');
    }
    const a = await actor(app, db, { regions: [1], grants: [['sites', 'view'], [await moduleOf('as_built'), 'view']] });
    const v = await rowValues(a.api, [s.code, empty.code]);
    expect(v.get(s.code)!['18']).toBe('WL+MW+IP');
    expect(v.get(empty.code)!['18']).toBeNull();
  });
});

describe('SITE 360 grid status filter', () => {
  it('filters on `status` (the name the web grid now sends)', async () => {
    const hold = await site(1, { status: 'on_hold' });
    const prog = await site(1, { status: 'in_progress' });
    const a = await actor(app, db, { regions: [1] });
    const res = await a.api.call('get', `/site360/master/rows?site_code=${hold.code},${prog.code}&status=on_hold`);
    expect(res.status).toBe(200);
    expect(res.body.filtered).toBe(1);
    expect(res.body.rows.map((r: { site_code: string }) => r.site_code)).toEqual([hold.code]);
  });
});

describe('GET /sites dashboard drill-downs: the list a card opens has the card count', () => {
  const MS = ['MS1', 'MS2', 'MS3', 'MS4', 'MS5', 'MS6', 'MS7', 'MS8', 'MS9', 'MS10'];
  let cluster: string;
  let reg: Awaited<ReturnType<typeof actor>>;
  const sites: Record<string, Site> = {};

  /** The first `done` milestones of the site approved `ago(j)` days ago, the next open, the rest locked (triggers off, as the dashboard fixture). */
  const milestones = async (s: Site, done: number, ago: (j: number) => number): Promise<void> => {
    for (let j = 1; j <= 10; j++) {
      const state = j <= done ? 'approved' : j === done + 1 ? 'open' : 'locked';
      await db.query(
        `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, actual_date, approved_date, updated_at)
         SELECT $1, $2, td.id, $3::"TaskState", $4, 3, CASE WHEN $5::int IS NULL THEN NULL ELSE cal_today() - $5::int END, CASE WHEN $5::int IS NULL THEN NULL ELSE cal_today() - $5::int END, now()
         FROM task_definitions td JOIN workflow_definitions w ON w.id = td.workflow_id AND w.version = 1 WHERE td.code = $6`,
        [s.id, s.region, state, state === 'open' ? 1 : 0, j <= done ? ago(j) : null, MS[j - 1]]);
    }
  };

  beforeAll(async () => {
    cluster = `${TAG}-CL`;
    const cl = (await db.query(`INSERT INTO clusters (cluster_code, name, is_global) VALUES ($1, 'P0 cluster', true) RETURNING id`, [cluster])).rows[0].id as string;
    // stored statuses differ on purpose from what the dashboard derives
    sites.onair = await site(1, { cluster: cl, status: 'not_started' });   // MS1..MS6 done, the last 5 days ago: derived in progress, On-Air reached
    sites.rfi = await site(1, { cluster: cl, status: 'on_hold' });         // MS1..MS4: in progress, RFI reached, not On-Air
    sites.none = await site(1, { cluster: cl, status: 'in_progress' });    // nothing done: not started
    sites.done = await site(1, { cluster: cl, status: 'in_progress' });    // all done: completed, HOTO and Final Closure reached
    sites.gone = await site(1, { cluster: cl, status: 'cancelled' });      // cancelled: counted nowhere but in cancelled
    sites.outside = await site(1, { status: 'in_progress' });             // another cluster: out of the drill-down
    await db.query('SET session_replication_role = replica');
    try {
      await milestones(sites.onair, 6, (j) => 35 - 5 * j);    // MS1 30 days ago ... MS6 5 days ago
      await milestones(sites.rfi, 4, (j) => 50 - 10 * j);
      await milestones(sites.none, 0, () => 0);
      await milestones(sites.done, 10, (j) => 110 - 10 * j);
      await milestones(sites.gone, 6, (j) => 70 - 10 * j);
      await milestones(sites.outside, 6, (j) => 70 - 10 * j);
    } finally {
      await db.query('SET session_replication_role = origin');
    }
    reg = await actor(app, db, { regions: [1], grants: [['sites', 'view'], ['dashboard', 'view']] });
  });

  const list = async (query: string): Promise<string[]> => {
    const res = await reg.api.call('get', `/sites?cluster_code=${encodeURIComponent(cluster)}&limit=200&${query}`);
    expect(res.status).toBe(200);
    expect(res.body.page.total).toBe(res.body.items.length);
    return (res.body.items as { site_code: string }[]).map((x) => x.site_code).sort();
  };
  const dashboard = async (query = ''): Promise<Record<string, any>> => {
    const res = await reg.api.call('get', `/dashboard?cluster_code=${encodeURIComponent(cluster)}${query}`);
    expect(res.status).toBe(200);
    return res.body as Record<string, any>;
  };

  it('a milestone card (RFI, On-Air, HOTO, Final Closure) opens the sites that reached the milestone, with the same count', async () => {
    const d = await dashboard();
    for (const code of ['MS4', 'MS6', 'MS9', 'MS10']) {
      const card = (d.headline.milestones as { code: string; done: number }[]).find((m) => m.code === code)!;
      const codes = await list(`milestone_reached=${code}`);
      expect(codes.length).toBe(card.done);
    }
    expect(await list('milestone_reached=MS6')).toEqual([sites.onair!.code, sites.done!.code].sort());
    expect(await list('milestone_reached=MS4')).toEqual([sites.onair!.code, sites.rfi!.code, sites.done!.code].sort());
    expect(d.headline.on_air.done).toBe(2);
    // the old link (current stage) listed the sites that have NOT reached it
    expect(await list('stage_code=MS6')).not.toContain(sites.onair!.code);
  });

  it('a status chip opens the sites of the derived status, not of the stored column, with the same count', async () => {
    const d = await dashboard();
    for (const st of ['not_started', 'in_progress', 'on_hold', 'completed', 'cancelled']) {
      expect((await list(`dashboard_status=${st}`)).length).toBe(d.headline.by_overall_status[st]);
    }
    expect(await list('dashboard_status=in_progress')).toEqual([sites.onair!.code, sites.rfi!.code].sort());
    expect(await list('dashboard_status=completed')).toEqual([sites.done!.code]);
    expect(await list('dashboard_status=not_started')).toEqual([sites.none!.code]);
    // the stored column says otherwise
    expect(await list('overall_status=not_started')).toEqual([sites.onair!.code]);
  });

  it('keeps the reference date: a past date counts what was done by then, on the card and in its list', async () => {
    const ref = (await db.query(`SELECT (cal_today() - 30)::text AS d`)).rows[0].d as string;
    const d = await dashboard(`&ref_date=${ref}`);
    const card = (d.headline.milestones as { code: string; done: number }[]).find((m) => m.code === 'MS6')!;
    const codes = await list(`milestone_reached=MS6&ref_date=${ref}`);
    expect(codes.length).toBe(card.done);
    expect(codes).toEqual([sites.done!.code]);   // On-Air of `onair` is later than the reference date
  });

  it('answers 422 for a wrong combination, an unknown status, a future date or ref_date alone', async () => {
    const future = (await db.query(`SELECT (cal_today() + 3)::text AS d`)).rows[0].d as string;
    for (const q of ['dashboard_status=done', 'dashboard_status=completed&milestone_reached=MS6', `milestone_reached=MS6&ref_date=${future}`, 'ref_date=2026-01-01', 'milestone_reached=MS6&ref_date=2026-02-30']) {
      const res = await reg.api.call('get', `/sites?${q}`);
      expect(res.status, q).toBe(422);
    }
  });

  it('is refused to a user without the dashboard view', async () => {
    const plain = await actor(app, db, { regions: [1], grants: [['sites', 'view']] });
    const res = await plain.api.call('get', `/sites?cluster_code=${encodeURIComponent(cluster)}&milestone_reached=MS6`);
    expect(res.status).toBe(403);
  });
});
