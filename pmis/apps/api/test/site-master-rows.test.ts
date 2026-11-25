import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggedIn, makeUser, startApp, superDb } from './helpers';
import { actor, addAssignment, makeSite, makeTask, Site } from './wf-helpers';

/** Site Master grid rows (0.15.21, F15, migration 0104): visibility, filters, sort, paging, the Master values and a 1000-site performance bound. */
const PREFIX = `S360${randomBytes(3).toString('hex').toUpperCase()}`;
let app: NestExpressApplication;
let db: PgClient;
/** A task code and Master order whose column takes the actual date of the task (no projection, no scenario filter). */
let dateMap: { task_code: string; ord: number };

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  const r = await db.query(`SELECT tf.task_code, mc.ord FROM template_task_fields tf JOIN master_columns mc ON mc.letter = tf.master_col
    WHERE tf.field_key = 'actual_date' AND tf.is_active AND tf.scenarios IS NULL AND tf.projection IS NULL
      AND EXISTS (SELECT 1 FROM task_definitions td JOIN workflow_definitions w ON w.id = td.workflow_id AND w.version = 1 WHERE td.code = tf.task_code)
    ORDER BY mc.ord LIMIT 1`);
  dateMap = r.rows[0] as { task_code: string; ord: number };
});
afterAll(async () => {
  await db.end();
  await app.close();
});

/** Site IDs of this file: the Site ID filter is an exact match, so the tests pass these codes. */
const created: string[] = [];
const site = async (region: number, over: { scenario?: string; status?: string } = {}): Promise<Site> => {
  const s = await makeSite(db, region, { prefix: PREFIX, ...over });
  created.push(s.code);
  return s;
};
const mine = (): string => created.join(',');

describe('GET /site360/{menu}/rows: the page and its values', () => {
  it('returns the menu columns and, per row, the identity and the actual date of a task from the view', async () => {
    const s = await site(1);
    await makeTask(db, s, dateMap.task_code, 'open', { actualDate: '2026-03-10' });
    const a = await actor(app, db, { regions: [1] });
    const res = await a.api.call('get', `/site360/master/rows?site_code=${s.code}`);
    expect(res.status).toBe(200);
    expect(res.body.menu.key).toBe('master');
    expect(res.body.menu.frozen_ords).toEqual([1, 2, 3, 4]);
    expect(res.body.rows).toHaveLength(1);
    const row = res.body.rows[0];
    expect(row.site_code).toBe(s.code);
    expect(row.row_no).toBe(1);
    expect(row.values['2']).toBe(s.code);
    expect(row.values['5']).toEqual(expect.any(String));
    expect(row.values[String(dateMap.ord)]).toBe('2026-03-10');
    expect(Object.keys(row.values)).toHaveLength(res.body.menu.columns.length);
  });

  it('gives the inline edit target of a task-backed cell: the task, its version and whether it is editable (locked = read-only)', async () => {
    const open = await site(1);
    const openTask = await makeTask(db, open, dateMap.task_code, 'open', { actualDate: '2026-03-11' });
    const locked = await site(1);
    await makeTask(db, locked, dateMap.task_code, 'locked');
    const a = await actor(app, db, { regions: [1] });
    const res = await a.api.call('get', `/site360/master/rows?site_code=${open.code},${locked.code}`);
    expect(res.status).toBe(200);
    const byCode = new Map<string, { cells: Record<string, { task_id: string; version: number; editable: boolean; field?: string }> }>(
      res.body.rows.map((r: { site_code: string; cells: unknown }) => [r.site_code, r as never]),
    );
    const cell = byCode.get(open.code)!.cells[String(dateMap.ord)]!;
    expect(cell.task_id).toBe(openTask);
    expect(cell.version).toEqual(expect.any(Number));
    expect(cell.editable).toBe(true);
    expect(cell.field).toBe('actual_date');
    expect(byCode.get(locked.code)!.cells[String(dateMap.ord)]!.editable).toBe(false);
    expect(byCode.get(open.code)!.cells['2']).toBeUndefined();
  });

  it('keeps the menu columns: a menu lists its own columns, the identity and the status columns only', async () => {
    const a = await actor(app, db, { regions: [1] });
    const res = await a.api.call('get', `/site360/design_acq/rows?site_code=${mine()}`);
    expect(res.status).toBe(200);
    const ords = res.body.menu.columns.map((c: { ord: number }) => c.ord);
    expect(ords).toContain(2);
    expect(ords).toContain(182);
    const section = res.body.menu.columns.filter((c: { sections: string[] }) => !c.sections.includes('design_acq'));
    expect(section.every((c: { ord: number; sections: string[] }) => [1, 2, 3, 4].includes(c.ord) || c.sections.includes('status'))).toBe(true);
    expect(res.body.menu.columns.length).toBeLessThan(187);
  });

  it('answers the counts: total is every visible site, filtered the sites that match', async () => {
    const tripoli = await site(1, { scenario: 'expansion' });
    const other = await site(1, { scenario: 'new_build' });
    const a = await actor(app, db, { regions: [1] });
    const all = await a.api.call('get', `/site360/master/rows?limit=5`);
    expect(all.body.total).toBeGreaterThanOrEqual(2);
    expect(all.body.filtered).toBe(all.body.total);
    const filtered = await a.api.call('get', `/site360/master/rows?site_code=${tripoli.code},${other.code}&scenario=expansion`);
    expect(filtered.body.filtered).toBe(1);
    expect(filtered.body.rows.map((r: { site_code: string }) => r.site_code)).toEqual([tripoli.code]);
    expect(filtered.body.total).toBe(all.body.total);
  });

  it('pages in the database: offset, limit and running row numbers', async () => {
    const a = await actor(app, db, { regions: [1] });
    const p1 = await a.api.call('get', `/site360/master/rows?site_code=${mine()}&sort=site_code&limit=1&offset=0`);
    const p2 = await a.api.call('get', `/site360/master/rows?site_code=${mine()}&sort=site_code&limit=1&offset=1`);
    expect(p1.body.filtered).toBe(created.length);
    expect(created.length).toBeGreaterThanOrEqual(3);
    expect(p1.body.rows[0].row_no).toBe(1);
    expect(p2.body.rows[0].row_no).toBe(2);
    expect(p2.body.rows[0].site_code).not.toBe(p1.body.rows[0].site_code);
  });

  it('sorts by a site field and by a Master column of the menu, descending', async () => {
    const a = await actor(app, db, { regions: [1] });
    const byCode = await a.api.call('get', `/site360/master/rows?site_code=${mine()}&sort=site_code&dir=desc&limit=200`);
    const codes = byCode.body.rows.map((r: { site_code: string }) => r.site_code);
    expect(codes).toEqual([...codes].sort().reverse());
    const byOrd = await a.api.call('get', `/site360/master/rows?site_code=${mine()}&sort=ord:${dateMap.ord}&limit=200`);
    expect(byOrd.status).toBe(200);
    const ordValues = byOrd.body.rows.map((r: { values: Record<string, string | null> }) => r.values[String(dateMap.ord)]);
    const set = ordValues.filter((v: string | null) => v !== null);
    expect(set).toEqual([...set].sort());
  });

  it('is limited to the regions of the caller (B3): a Benghazi site is not in the rows of a Tripoli user', async () => {
    const benghazi = await site(5);
    const user = await makeUser(db, { status: 'active' });
    await addAssignment(db, user.id, { level: 'entry', regions: [1], modules: null, grants: [['sites', 'view']] });
    const api = await loggedIn(app, user);
    const res = await api.call('get', `/site360/master/rows?site_code=${benghazi.code}`);
    expect(res.status).toBe(200);
    expect(res.body.filtered).toBe(0);
    expect(res.body.rows).toEqual([]);
  });

  it('fills the issue columns (GA:GE) from the open issue of the site', async () => {
    const s = await site(1);
    await db.query(`INSERT INTO issues (site_id, region_id, title, detail, raised_date, status) VALUES ($1, 1, 'Access road blocked', 'Gate closed', DATE '2026-04-02', 'open')`, [s.id]);
    const a = await actor(app, db, { regions: [1], grants: [['sites', 'view'], ['issues', 'view']] });
    const res = await a.api.call('get', `/site360/master/rows?site_code=${s.code}`);
    expect(res.status).toBe(200);
    const values = res.body.rows[0].values;
    expect(values['183']).toBe('Access road blocked');
    const hidden = await actor(app, db, { regions: [1], grants: [['sites', 'view']] });
    const none = await hidden.api.call('get', `/site360/master/rows?site_code=${s.code}`);
    expect(none.body.rows[0].values['183']).toBeNull();
    expect(values['185']).toBe('2026-04-02');
    expect(values['186']).toBe('open');
    expect(values['187']).toBe('Gate closed');
  });

  it('answers 422 for an unknown menu, sort or a page size over 200', async () => {
    const a = await actor(app, db, { regions: [1] });
    expect((await a.api.call('get', '/site360/nope/rows')).status).toBe(422);
    expect((await a.api.call('get', '/site360/master/rows?sort=drop_table')).status).toBe(422);
    expect((await a.api.call('get', '/site360/master/rows?limit=500')).status).toBe(422);
    expect((await a.api.call('get', '/site360/master/rows?region_id=9')).status).toBe(422);
  });
});

describe('performance: one page of 1000 sites stays under 2 seconds', () => {
  it('reads the first page and a sorted page on a synthetic 1000-site register', async () => {
    const PERF = `PERF${randomBytes(2).toString('hex').toUpperCase()}`;
    await db.query(`INSERT INTO sites (site_code, name, region_id, workflow_version_id, project_phase, delivery_batch, delivery_scenario, overall_status, current_milestone, updated_at)
      SELECT $1 || lpad(g::text, 4, '0'), 'Synthetic site ' || g, 1 + (g % 7), (SELECT id FROM workflow_definitions WHERE version = 1),
             'Phase ' || (g % 3), 'Batch ' || (g % 5), 'new_build', 'in_progress', 'Site Release', now()
      FROM generate_series(1, 1000) g`, [PERF]);
    await db.query(`INSERT INTO task_instances (site_id, region_id, task_def_id, state, actual_date, updated_at)
      SELECT s.id, s.region_id, td.id, 'open', DATE '2026-02-01' + (s.region_id), now()
      FROM sites s JOIN task_definitions td ON td.workflow_id = s.workflow_version_id AND td.code = $1
      WHERE s.site_code LIKE $2 || '%'`, [dateMap.task_code, PERF]);
    const admin = await actor(app, db, { regions: null });
    const t0 = Date.now();
    const first = await admin.api.call('get', `/site360/master/rows?region_id=1,2,3,4,5,6,7&limit=50&sort=site_code`);
    const firstMs = Date.now() - t0;
    expect(first.status).toBe(200);
    expect(first.body.total).toBeGreaterThanOrEqual(1000);
    expect(first.body.filtered).toBe(first.body.total);
    expect(first.body.rows).toHaveLength(50);
    expect(firstMs).toBeLessThan(2000);
    const t1 = Date.now();
    const sorted = await admin.api.call('get', `/site360/master/rows?region_id=1,2,3,4,5,6,7&sort=ord:${dateMap.ord}&dir=desc&offset=50&limit=50`);
    const sortedMs = Date.now() - t1;
    expect(sorted.status).toBe(200);
    expect(sorted.body.rows[0].row_no).toBe(51);
    expect(sortedMs).toBeLessThan(2000);
  });
});

describe('GET /site360/{menu}/rows: the calc columns of the procurement and GECOL registers (0107)', () => {
  it('reads the contractor of the first active CW order (AJ, AK) and the GECOL status (BW), and filters by contractor', async () => {
    const s = await site(1);
    const name = `${PREFIX}-CON-${randomBytes(2).toString('hex')}`;
    const party = (await db.query(`INSERT INTO external_parties (name, type, is_active) VALUES ($1, 'cw_contractor', true) RETURNING id`, [name])).rows[0].id as string;
    const team = (await db.query(`INSERT INTO external_teams (party_id, name) VALUES ($1, $2) RETURNING id`, [party, `${name} team`])).rows[0].id as string;
    const other = (await db.query(`INSERT INTO external_parties (name, type, is_active) VALUES ($1, 'cw_contractor', true) RETURNING id`, [`${name}-X`])).rows[0].id as string;
    // a cancelled order that is earlier does not count; the active one is the contractor
    await db.query(`INSERT INTO procurement_records (site_id, region_id, scope, order_status, party_id, po_wo_date) VALUES ($1, 1, 'CW', 'cancelled by owner', $2, DATE '2026-01-05')`, [s.id, other]);
    await db.query(`INSERT INTO procurement_records (site_id, region_id, scope, order_status, party_id, team_id, po_wo_date) VALUES ($1, 1, 'CW', 'issued', $2, $3, DATE '2026-02-05')`, [s.id, party, team]);
    await db.query(`INSERT INTO gecol_records (site_id, region_id, status) VALUES ($1, 1, 'energised')`, [s.id]);
    const mod = (await db.query(`SELECT module_key FROM register_definitions WHERE register_key = 'procurement'`)).rows[0].module_key as string;
    const gecolMod = (await db.query(`SELECT module_key FROM register_definitions WHERE register_key = 'gecol'`)).rows[0].module_key as string;
    const a = await actor(app, db, { regions: [1], grants: [['sites', 'view'], [mod, 'view'], [gecolMod, 'view']] });
    const res = await a.api.call('get', `/site360/master/rows?site_code=${s.code}`);
    expect(res.status).toBe(200);
    expect(res.body.rows[0].values['36']).toBe(name);
    expect(res.body.rows[0].values['37']).toBe(`${name} team`);
    // 0119: BW is the workbook formula (the scope AC of this site is N/A); the unwritten gecol_records.status is no longer read
    expect(res.body.rows[0].values['75']).toBe('N/A');
    const hit = await a.api.call('get', `/site360/master/rows?site_code=${s.code}&contractor=${encodeURIComponent(name)}`);
    expect(hit.body.filtered).toBe(1);
    const miss = await a.api.call('get', `/site360/master/rows?site_code=${s.code}&contractor=${encodeURIComponent(`${name}-X`)}`);
    expect(miss.body.filtered).toBe(0);
  });

  it('reads the CW Access Date (AL) from the earliest approved Access - CW permit, and the HLC Fiber Status (BX) from the HLC record (0111)', async () => {
    const s = await site(1);
    await db.query(`UPDATE sites SET scope_hlc_fiber = 'yes' WHERE id = $1`, [s.id]);
    await db.query(`INSERT INTO permit_records (site_id, region_id, permit_type, status, valid_from, valid_to, has_expiry) VALUES ($1, 1, 'Access - CW', 'Approved', DATE '2026-03-01', DATE '2027-12-31', true), ($1, 1, 'Access - CW', 'Approved', DATE '2026-02-01', DATE '2027-12-31', true), ($1, 1, 'Access - CW', 'Applied', DATE '2025-12-01', NULL, true)`, [s.id]);
    await db.query(`INSERT INTO hlc_records (site_id, region_id, installation_date) VALUES ($1, 1, DATE '2026-04-10')`, [s.id]);
    const hlcSite = await site(1);
    await db.query(`UPDATE sites SET scope_hlc_fiber = 'na' WHERE id = $1`, [hlcSite.id]);
    const permMod = (await db.query(`SELECT module_key FROM register_definitions WHERE register_key = 'permits_hse'`)).rows[0].module_key as string;
    const hlcMod = (await db.query(`SELECT module_key FROM register_definitions WHERE register_key = 'hlc'`)).rows[0].module_key as string;
    const a = await actor(app, db, { regions: [1], grants: [['sites', 'view'], [permMod, 'view'], [hlcMod, 'view']] });
    const res = await a.api.call('get', `/site360/master/rows?site_code=${s.code},${hlcSite.code}`);
    expect(res.status).toBe(200);
    const byCode = new Map<string, Record<string, string | null>>(res.body.rows.map((r: { site_code: string; values: Record<string, string | null> }) => [r.site_code, r.values]));
    expect(byCode.get(s.code)!['38']).toBe('2026-02-01');
    expect(byCode.get(s.code)!['76']).toBe('Done');
    expect(byCode.get(hlcSite.code)!['76']).toBe('N/A');
    expect(byCode.get(hlcSite.code)!['38']).toBeNull();
  });

  it('hides the procurement and GECOL values, and the contractor filter, from a user without their module view', async () => {
    const s = await site(1);
    const name = `${PREFIX}-HID-${randomBytes(2).toString('hex')}`;
    const party = (await db.query(`INSERT INTO external_parties (name, type, is_active) VALUES ($1, 'cw_contractor', true) RETURNING id`, [name])).rows[0].id as string;
    await db.query(`INSERT INTO procurement_records (site_id, region_id, scope, order_status, party_id) VALUES ($1, 1, 'CW', 'issued', $2)`, [s.id, party]);
    const a = await actor(app, db, { regions: [1], grants: [['sites', 'view']] });
    const res = await a.api.call('get', `/site360/master/rows?site_code=${s.code}`);
    expect(res.body.rows[0].values['36']).toBeNull();
    const hit = await a.api.call('get', `/site360/master/rows?site_code=${s.code}&contractor=${encodeURIComponent(name)}`);
    expect(hit.body.filtered).toBe(0);
  });
});

