import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { ImportJobsService } from '../src/templates/import-jobs.service';
import { Api, delegate, loggedIn, makeUser, startApp, superDbWl } from './helpers';
import { day, uploadFile } from './tpl-helpers';
import { SITE_APPROVE_GRANTS, filled } from './tpl-stream-helpers';
import { Actor, Site, actor, makeSite, makeTask, plainAdmin, setCell } from './wf-helpers';

/**
 * Migration 0085 (owner request 2026-11-10): per-site workflow locks, the historical load without locks, the missing data of a historical load, and new sites
 * created "Open". Its own database (TEST_DATABASE_URL_WL; the seeded Document Library is off): the suite opens the historical-load waiver and reads the dashboard
 * count of the lock bypasses. Region 4 holds the tasks, region 5 is the "other" region; region 7 holds the Site creation cells.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 4;
const OTHER = 5;
const REASON = 'Historical tasks of the owner Master, entered as they are';
const TAG = randomBytes(2).toString('hex').toUpperCase();

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_WL as string });
  db = await superDbWl();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

interface Team { admin: Actor; approver: Actor }
/** A System Admin holding L1 of the given tasks in the region, and an approver holding L2. */
async function team(codes: string[], region = R): Promise<Team> {
  const admin = await plainAdmin(app, db);
  const approver = await actor(app, db, { level: 'approve', grants: SITE_APPROVE_GRANTS, regions: [region], modules: null });
  for (const c of codes) {
    await setCell(db, c, region, 'entry', { user: [admin.user.id] });
    await setCell(db, c, region, 'approve', { user: [approver.user.id] });
  }
  return { admin, approver };
}
const task = async (id: string) => (await q<{ state: string; lock_reason: string | null; bypassed: boolean; why: string | null; pending: string | null; actual_date: string | null; version: number }>(db,
  `SELECT state::text AS state, lock_reason, lock_bypassed AS bypassed, lock_bypass_reason AS why, lock_bypass_pending AS pending, actual_date::text AS actual_date, version
   FROM task_instances WHERE id = $1`, [id]))[0]!;
const locksOf = async (siteId: string) => (await q<{ l: boolean }>(db, 'SELECT workflow_locks AS l FROM sites WHERE id = $1', [siteId]))[0]!.l;
const audit = (action: string, entityId: string) =>
  q<{ before: Record<string, any> | null; after: Record<string, any> | null; reason: string | null; is_admin_override: boolean; actor_id: string | null }>(
    db, 'SELECT before, after, reason, is_admin_override, actor_id FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY id', [action, entityId]);
const setLocks = (a: Actor, site: Site, locked: boolean, reason = 'The site follows its own order of work') =>
  a.api.call('put', `/sites/${site.id}/workflow-locks`, { locked, reason });
const act = (a: Actor, id: string, verb: string, version: number, body: unknown = {}) => a.api.call('post', `/tasks/${id}/${verb}`, body, { 'If-Match': `"${version}"` });
const patch = (a: Actor, id: string, version: number, body: unknown) => a.api.call('patch', `/tasks/${id}`, body, { 'If-Match': `"${version}"` });

/** Starts, dates and submits a task as L1 (the admin), then approves it as L2. */
async function enterAndApprove(t: Team, id: string, date: string): Promise<void> {
  let v = (await task(id)).version;
  const st = await act(t.admin, id, 'start', v, { actual_start: date });
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  v = (await task(id)).version;
  expect((await patch(t.admin, id, v, { actual_date: date })).status).toBe(200);
  v = (await task(id)).version;
  const sub = await act(t.admin, id, 'submit', v);
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  expect((await task(id)).state).toBe('in_approval');   // L1 then L2: the open site changes nothing in the two levels
  v = (await task(id)).version;
  const ap = await act(t.approver, id, 'approve', v);
  expect(ap.status, JSON.stringify(ap.body)).toBe(200);
}

describe('a locked site behaves as before', () => {
  it('keeps a task locked behind its predecessor and refuses to start it; a stream upload holds the row', async () => {
    const t = await team(['A1', 'A2']);
    const site = await makeSite(db, R, { prefix: 'WLK' });
    await makeTask(db, site, 'A1', 'open');
    const a2 = await makeTask(db, site, 'A2', 'locked');
    expect(await locksOf(site.id)).toBe(true);
    const st = await act(t.admin, a2, 'start', (await task(a2)).version, { actual_start: '2026-01-05' });
    expect(st.status).toBe(409);
    expect(st.body.code).toBe('invalid_transition');
    const site360 = await t.admin.api.call('get', `/sites/${site.id}`);
    expect(site360.body).toMatchObject({ workflow_locks: true, workflow_locks_info: { can_manage: true } });
    const grid = await t.admin.api.call('get', `/sites/${site.id}/tasks`);
    const row = (grid.body.stages as { tasks: { task_code: string; state: string; lock_reasons: { kind: string }[] }[] }[]).flatMap((x) => x.tasks).find((x) => x.task_code === 'A2')!;
    expect(row.state).toBe('locked');
    expect(row.lock_reasons.map((r) => r.kind)).toContain('predecessor_not_approved');
  });
});

describe('an open site: dates in any order, two levels kept, the bypass flagged', () => {
  it('opens the locked tasks, accepts a successor before its predecessor, flags the approval, shows the badge and counts it as an override', async () => {
    const t = await team(['A1', 'A2']);
    const site = await makeSite(db, R, { prefix: 'WLO' });
    const a1 = await makeTask(db, site, 'A1', 'open');
    const a2 = await makeTask(db, site, 'A2', 'locked');
    const res = await setLocks(t.admin, site, false);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ workflow_locks: false, changed: 1, sites: [{ site_id: site.id, changed: true, tasks_opened: ['A2'] }] });
    expect(await locksOf(site.id)).toBe(false);
    expect(await task(a2)).toMatchObject({ state: 'open', pending: 'predecessor_open:A1' });
    const au = (await audit('site_workflow_locks_set', site.id)).at(-1)!;
    expect(au).toMatchObject({ before: { workflow_locks: true }, after: { workflow_locks: false, source: 'manual', tasks_opened: ['A2'] }, is_admin_override: true, actor_id: t.admin.user.id });

    // A2 before A1: L1 then L2, the approval needs the approver
    await enterAndApprove(t, a2, '2026-01-05');
    expect(await task(a2)).toMatchObject({ state: 'approved', bypassed: true, why: 'predecessor_open:A1', pending: null });
    expect((await task(a1)).state).toBe('open');
    expect((await audit('task_lock_bypassed', a2))[0]).toMatchObject({ is_admin_override: true, after: { lock_bypassed: true, lock_bypass_reason: 'predecessor_open:A1' } });
    const dto = await t.admin.api.call('get', `/tasks/${a2}`);
    expect(dto.body).toMatchObject({ lock_bypassed: true, lock_bypass_reason: 'predecessor_open:A1' });
    // the KPIs: an override (flagged, and left out of SLA / on-time while exclude_overrides is on)
    const kpi = await q<{ n: string }>(db, `SELECT count(*)::text AS n FROM task_instances WHERE lock_bypassed AND site_id = $1`, [site.id]);
    expect(kpi[0]!.n).toBe('1');
    const dash = await t.admin.api.call('get', '/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body.meta.lock_bypass_flagged_count).toBeGreaterThanOrEqual(1);
    expect(dash.body.meta.override_flagged_count).toBeGreaterThanOrEqual(1);
    // A1 later: no bypass (nothing held it)
    await enterAndApprove(t, a1, '2026-01-04');
    expect(await task(a1)).toMatchObject({ state: 'approved', bypassed: false });
  });

  it('enters a task through a gate that is not open (gate_closed) and flags it', async () => {
    const t = await team(['B1']);
    const site = await makeSite(db, R, { prefix: 'WLG' });
    await makeTask(db, site, 'MS1', 'approved');   // the predecessor is done, but the milestone has no date: the gate G2 is not open
    const b1 = await makeTask(db, site, 'B1', 'locked');
    await db.query(`UPDATE task_instances SET lock_reason = 'gate_closed:G2' WHERE id = $1`, [b1]);
    expect((await act(t.admin, b1, 'start', (await task(b1)).version, { actual_start: '2026-01-05' })).status).toBe(409);
    expect((await setLocks(t.admin, site, false)).status).toBe(200);
    await enterAndApprove(t, b1, '2026-01-06');
    const done = await task(b1);
    expect(done.state).toBe('approved');
    expect(done.bypassed).toBe(true);
    expect(done.why).toMatch(/^gate_closed:G2$|^predecessor_open:/);
  });

  it('a locked task created on the open site later is opened by the start itself (one audit row)', async () => {
    const t = await team(['A1', 'A3']);
    const site = await makeSite(db, R, { prefix: 'WLS' });
    await makeTask(db, site, 'A1', 'open');
    expect((await setLocks(t.admin, site, false)).status).toBe(200);
    const a3 = await makeTask(db, site, 'A3', 'locked');
    const st = await act(t.admin, a3, 'start', (await task(a3)).version, { actual_start: '2026-01-05' });
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    expect(await task(a3)).toMatchObject({ state: 'entry', pending: 'predecessor_open:A1' });
    expect((await audit('task_unlock', a3)).length).toBe(1);
  });

  it('switching back to Locked re-locks the untouched tasks and keeps the entered ones', async () => {
    const t = await team(['A1', 'A2', 'A3']);
    const site = await makeSite(db, R, { prefix: 'WLB' });
    await makeTask(db, site, 'A1', 'open');
    const a2 = await makeTask(db, site, 'A2', 'locked');
    const a3 = await makeTask(db, site, 'A3', 'locked');
    expect((await setLocks(t.admin, site, false)).status).toBe(200);
    const v = (await task(a3)).version;
    expect((await act(t.admin, a3, 'start', v, { actual_start: '2026-01-05' })).status).toBe(200);
    const back = await setLocks(t.admin, site, true, 'The load is finished: the order of work applies again');
    expect(back.status).toBe(200);
    expect(back.body.sites[0]).toMatchObject({ changed: true, workflow_locks: true, tasks_relocked: ['A2'] });
    expect(await task(a2)).toMatchObject({ state: 'locked', pending: null });
    expect((await task(a3)).state).toBe('entry');
    expect((await setLocks(t.admin, site, true)).body).toMatchObject({ changed: 0, unchanged: 1 });
  });
});

describe('who switches the locks', () => {
  it('a System Admin or a holder of the delegated right to unlock for the region; reason 422, step-up 401, rights 403, a direct write refused', async () => {
    await team(['A1']);
    const site = await makeSite(db, R, { prefix: 'WLR' });
    const other = await makeSite(db, OTHER, { prefix: 'WLR' });
    const plain = await actor(app, db, { grants: [['sites', 'view'], ['sites', 'edit'], ['sites', 'administer']], regions: [R], modules: null });
    const denied = await setLocks(plain, site, false);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('action_forbidden');
    expect((await plain.api.call('get', `/sites/${site.id}`)).body.workflow_locks_info.can_manage).toBe(false);

    const dg = await makeUser(db, { assigned: true });
    await delegate(db, dg.id, [['sites', 'view'], ['overrides.unlock', 'administer']], [R]);
    const dgApi = await loggedIn(app, dg);
    const dgActor = { user: dg, api: dgApi, roleId: '' } as unknown as Actor;
    const cold = await setLocks(dgActor, site, false);
    expect(cold.status).toBe(401);
    expect(cold.body.code).toBe('step_up_required');
    expect((await dgApi.stepUp(dg.password)).status).toBe(200);
    expect((await dgApi.call('put', `/sites/${site.id}/workflow-locks`, { locked: false, reason: 'x' })).status).toBe(422);
    expect((await dgApi.call('put', `/sites/${site.id}/workflow-locks`, { locked: false })).status).toBe(422);
    // the delegate's region only: a site of another region is not visible (404) or not covered (403)
    const out = await setLocks(dgActor, other, false);
    expect([403, 404]).toContain(out.status);
    const ok = await setLocks(dgActor, site, false);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await locksOf(site.id)).toBe(false);
    expect(await locksOf(other.id)).toBe(true);
    // a bulk that names a site outside the right changes nothing
    const both = await dgApi.call('post', '/sites/workflow-locks', { locked: true, reason: 'Back to the order of work', site_ids: [site.id, other.id] });
    expect([403, 404]).toContain(both.status);
    expect(await locksOf(site.id)).toBe(false);

    // the superuser of the test is the migration role; the API role (pmis_app) has no right on the column
    const app_ = await q<{ ok: boolean }>(db, `SELECT has_column_privilege('pmis_app', 'sites', 'workflow_locks', 'UPDATE') AS ok`);
    expect(app_[0]!.ok).toBe(false);
    const flag = await q<{ ok: boolean }>(db, `SELECT has_column_privilege('pmis_app', 'task_instances', 'lock_bypassed', 'UPDATE') AS ok`);
    expect(flag[0]!.ok).toBe(false);
  });

  it('bulk: many sites with one reason, audited per site', async () => {
    const t = await team(['A1']);
    const s1 = await makeSite(db, R, { prefix: 'WLM' });
    const s2 = await makeSite(db, R, { prefix: 'WLM' });
    const res = await t.admin.api.call('post', '/sites/workflow-locks', { locked: false, reason: 'Both sites follow the field order', site_ids: [s1.id, s2.id] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ workflow_locks: false, changed: 2, unchanged: 0 });
    for (const s of [s1, s2]) expect((await audit('site_workflow_locks_set', s.id)).at(-1)).toMatchObject({ after: { source: 'bulk' }, reason: 'Both sites follow the field order' });
    expect((await t.admin.api.call('post', '/sites/workflow-locks', { locked: false, reason: 'two sources', site_ids: [s1.id], master_run_id: s1.id })).status).toBe(422);
    const list = await t.admin.api.call('get', `/sites?workflow_locks=open&q=${encodeURIComponent(s1.code)}`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([s1.id]);
    expect(list.body.items[0]).toMatchObject({ workflow_locks: false, data_gaps: 0 });
    expect((await t.admin.api.call('get', `/sites?workflow_locks=locked&q=${encodeURIComponent(s1.code)}`)).body.items).toEqual([]);
    expect((await t.admin.api.call('get', '/sites?workflow_locks=maybe')).status).toBe(422);
  });
});

describe('the historical load: no locks, missing data as warnings, every site with a status', () => {
  type Cell = string | number | Date;
  async function masterFile(rows: Record<string, Cell>[]): Promise<Buffer> {
    const cols = await q<{ letter: string; group_top: string | null; group_mid: string | null; name: string | null }>(db, 'SELECT letter, group_top, group_mid, name FROM master_columns WHERE is_active ORDER BY ord');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Guide').getCell('A1').value = 'Guide';
    const ws = wb.addWorksheet('Master');
    for (const c of cols) {
      ws.getCell(`${c.letter}1`).value = c.group_top ?? null;
      ws.getCell(`${c.letter}2`).value = c.group_mid ?? null;
      ws.getCell(`${c.letter}3`).value = c.name ?? null;
      ws.getCell(`${c.letter}4`).value = { formula: `SUBTOTAL(3,${c.letter}5:${c.letter}504)`, result: 0 };
    }
    rows.forEach((r, i) => {
      for (const [L, v] of Object.entries(r)) {
        const cell = ws.getCell(`${L}${5 + i}`);
        cell.value = v as ExcelJS.CellValue;
        if (v instanceof Date) cell.numFmt = 'yyyy-mm-dd';
      }
    });
    const st = wb.addWorksheet('Setting');
    st.getCell('I1').value = 'Project Staff';
    ['Name', 'Role', 'Region', 'Status'].forEach((h, i) => { st.getCell(2, 9 + i).value = h; });
    for (const s of ['RF & Design', 'Acquisition']) wb.addWorksheet(s);
    return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  }
  const uploadMaster = (api: Api, buf: Buffer): request.Test => {
    const r = api.raw('post', '/master-import/runs');
    if (api.csrf) r.set('X-CSRF-Token', api.csrf);
    return r.attach('file', buf, { filename: 'GSDN_Site_Master.xlsx', contentType: 'application/octet-stream' });
  };
  const openWaiver = async (a: Actor) => {
    const r = await a.api.call('put', '/settings/historical-waiver', { open: true, cutoff_date: '2026-06-30', reason: 'Open for the historical load' });
    return { status: r.status === 409 ? 200 : r.status };   // already open (an earlier test of this file)
  };

  it('a historical Master apply opens the sites, accepts out-of-order dates, reports blanks as warnings, and lists every site with its status', async () => {
    // B4 waits for B3 (open, no date); B4 "Actual Date" is AO, "Planned Date" AN
    const t = await team(['B3', 'B4']);
    const full = await makeSite(db, R, { prefix: 'WLH' });
    const sparse = await makeSite(db, R, { prefix: 'WLH' });
    const blank = await makeSite(db, R, { prefix: 'WLH' });
    const bad = await makeSite(db, R, { prefix: 'WLH' });
    const tasks: Record<string, Record<string, string>> = {};
    for (const s of [full, sparse, blank, bad]) tasks[s.id] = { B3: await makeTask(db, s, 'B3', 'open'), B4: await makeTask(db, s, 'B4', 'locked') };
    expect((await openWaiver(t.admin)).status).toBe(200);

    const run = await uploadMaster(t.admin.api, await masterFile([
      { A: 1, B: full.code, AO: day('2026-02-10') },        // a later task with a date, its predecessor blank
      { A: 2, B: sparse.code, AN: day('2026-03-01') },      // only a planned date: saved, not submitted
      { A: 3, B: blank.code },                              // only the Site ID
      { A: 4, B: bad.code, AO: 'not a date', AN: day('2026-03-02') },   // an invalid cell: only that cell is refused
    ]));
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const applied = await t.admin.api.call('post', `/master-import/runs/${run.body.id}/apply`, { mode: 'submit', reason: 'Initial load', historical_load: { reason: REASON } },
      { 'If-Match': `"${run.body.version}"` });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);

    // every site of the file lost its locks first, audited per site with the reason of the load
    for (const s of [full, sparse, blank, bad]) {
      expect(await locksOf(s.id)).toBe(false);
      expect((await audit('site_workflow_locks_set', s.id)).at(-1)).toMatchObject({ after: { workflow_locks: false, source: 'historical_master_import' }, reason: `Historical load: ${REASON}` });
    }
    // the full site: B4 submitted before B3, nothing held
    expect((await task(tasks[full.id]!.B4!)).state).toBe('in_approval');
    const batchId = applied.body.outcome.batches[0].id as string;
    const rows = (await t.admin.api.call('get', `/import-batches/${batchId}/rows?limit=200`)).body.items as { site_code: string; task_code: string; action: string; hold_reason: string | null; warnings: { code: string }[]; errors: { code: string }[] }[];
    // the sparse site: B4 saved (planned date) and not submitted
    const sp = await q<{ state: string; planned: string | null }>(db, 'SELECT state::text AS state, planned_date::text AS planned FROM task_instances WHERE id = $1', [tasks[sparse.id]!.B4]);
    expect(sp[0], JSON.stringify(rows.filter((r) => r.site_code === sparse.code))).toMatchObject({ planned: '2026-03-01' });
    expect(['open', 'entry']).toContain(sp[0]!.state);
    expect(rows.filter((r) => r.hold_reason)).toEqual([]);
    const fullRow = rows.find((r) => r.site_code === full.code && r.task_code === 'B4')!;
    expect(fullRow.action).toBe('update');
    expect(fullRow.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['missing_predecessor_date']));
    const sparseRow = rows.find((r) => r.site_code === sparse.code && r.task_code === 'B4')!;
    expect(sparseRow.action).toBe('update');
    expect(sparseRow.warnings.map((w) => w.code)).toContain('missing_actual_date');
    // the invalid date is an error of its own task only; no row is refused for a blank
    const badErrors = rows.filter((r) => r.action === 'error');
    expect(badErrors.every((r) => r.site_code === bad.code)).toBe(true);
    expect(badErrors.flatMap((r) => r.errors.map((e) => e.code))).not.toContain('actual_date_required');

    // the run page: every site of the file with its status, its warnings and its data gaps
    const st = await t.admin.api.call('get', `/master-import/runs/${run.body.id}/sites`);
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    const byCode = new Map((st.body.items as { site_code: string }[]).map((x) => [x.site_code, x as Record<string, unknown>]));
    for (const s of [full, sparse, blank, bad]) {
      expect(byCode.get(s.code)).toMatchObject({ site_id: s.id, workflow_locks: false, overall_status: expect.any(String), total_tasks: expect.any(Number), done_tasks: expect.any(Number) });
    }
    expect(Number(byCode.get(full.code)!.warnings)).toBeGreaterThan(0);
    expect(Number(byCode.get(full.code)!.data_gaps)).toBeGreaterThan(0);   // B3 has no date while B4 has one
    const only = await t.admin.api.call('get', `/master-import/runs/${run.body.id}/sites?gaps=only`);
    expect((only.body.items as { site_code: string }[]).map((x) => x.site_code)).toContain(full.code);
    expect((only.body.items as { site_code: string }[]).map((x) => x.site_code)).not.toContain(blank.code);
    // the site page and SITE 360 show the gap
    const page = await t.admin.api.call('get', `/sites/${full.id}`);
    expect(page.body.data_gaps).toBeGreaterThan(0);
    expect(page.body.data_gap_items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'missing_actual_date', task_code: 'B3', successor_code: 'B4' })]));
    expect((await t.admin.api.call('get', `/sites?data_gaps=with&q=${encodeURIComponent(full.code)}`)).body.items).toHaveLength(1);

    // L2 approves the batch: the bypass is recorded on B4
    const b = await t.admin.api.call('get', `/import-batches/${batchId}`);
    const dec = await t.approver.api.call('post', `/import-batches/${batchId}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': `"${b.body.version}"` });
    expect(dec.status, JSON.stringify(dec.body)).toBe(200);
    expect(await task(tasks[full.id]!.B4!)).toMatchObject({ state: 'approved', bypassed: true, why: 'predecessor_open:B3' });

    // the sites of the run go back to Locked in one call
    const back = await t.admin.api.call('post', '/sites/workflow-locks', { locked: true, reason: 'The historical load is done', master_run_id: run.body.id });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.changed).toBe(4);
    expect(await locksOf(full.id)).toBe(true);
  });

  it('a big historical apply runs in the background (0086): all or nothing, a refusal there changes nothing and the file can be applied again', async () => {
    const jobs = app.get(ImportJobsService);
    jobs.autoStart = false;
    await db.query(`UPDATE settings SET value = to_jsonb(2) WHERE key = 'imports.async_rows'`);
    try {
      const t = await team(['B3', 'B4']);
      const sites = [await makeSite(db, R, { prefix: 'WLB' }), await makeSite(db, R, { prefix: 'WLB' }), await makeSite(db, R, { prefix: 'WLB' })];
      const b4: Record<string, string> = {};
      for (const s of sites) { await makeTask(db, s, 'B3', 'open'); b4[s.id] = await makeTask(db, s, 'B4', 'locked'); }
      expect((await openWaiver(t.admin)).status).toBe(200);
      const run = await uploadMaster(t.admin.api, await masterFile(sites.map((s, i) => ({ A: i + 1, B: s.code, AO: day('2026-02-10') }))));
      expect(run.status, JSON.stringify(run.body)).toBe(201);
      const body = { mode: 'submit', reason: 'Initial load', historical_load: { reason: REASON } };
      const queued = await t.admin.api.call('post', `/master-import/runs/${run.body.id}/apply`, body, { 'If-Match': `"${run.body.version}"` });
      expect(queued.status, JSON.stringify(queued.body)).toBe(202);
      expect(queued.body).toMatchObject({ status: 'applying', outcome: null, applying: { state: 'running', sites_total: 3 } });
      for (const s of sites) expect(await locksOf(s.id)).toBe(true);                       // nothing changed in the request
      // the waiver closes before the background run: the run is refused there, nothing changes, the run can be applied again
      const close = await t.admin.api.call('put', '/settings/historical-waiver', { open: false, reason: 'Closed before the run' });
      expect(close.status, JSON.stringify(close.body)).toBe(200);
      const job = (await jobs.pending(0)).find((x) => x.apply && x.job_id === queued.body.applying.job_id)!;
      await jobs.process(job);
      const failed = await t.admin.api.call('get', `/master-import/runs/${run.body.id}`);
      expect(failed.body).toMatchObject({ status: 'previewed', applying: { state: 'failed', error_code: 'invalid_transition' } });
      expect(failed.body.applying.error).toContain('waiver is closed');
      for (const s of sites) {
        expect(await locksOf(s.id)).toBe(true);
        expect((await task(b4[s.id]!)).state).toBe('locked');
      }
      expect((await audit('master_import.apply_failed', run.body.id)).at(-1)).toMatchObject({ after: { status: 'previewed', code: 'invalid_transition' } });

      // again with the waiver open: applied in the background, every site opened (audited), B4 submitted before B3
      expect((await openWaiver(t.admin)).status).toBe(200);
      const again = await t.admin.api.call('post', `/master-import/runs/${run.body.id}/apply`, body, { 'If-Match': `"${failed.body.version}"` });
      expect(again.status, JSON.stringify(again.body)).toBe(202);
      await jobs.process((await jobs.pending(0)).find((x) => x.apply && x.job_id === again.body.applying.job_id)!);
      const done = await t.admin.api.call('get', `/master-import/runs/${run.body.id}`);
      expect(done.body).toMatchObject({ status: 'applied', apply_reason: 'Initial load', applying: { state: 'done' } });
      expect(done.body.outcome.batches).toHaveLength(1);
      // its batch has more rows than the threshold too: sent in the background, as after an apply in the request (0075)
      const bq = done.body.outcome.batches[0] as { id: string; queued?: boolean };
      expect(bq.queued).toBe(true);
      await jobs.process((await jobs.pending(0)).find((x) => x.batch_id === bq.id)!);
      for (const s of sites) {
        expect(await locksOf(s.id)).toBe(false);
        expect((await audit('site_workflow_locks_set', s.id)).at(-1)).toMatchObject({ after: { workflow_locks: false, source: 'historical_master_import', tasks_opened: ['B4'] } });
        expect((await task(b4[s.id]!)).state).toBe('in_approval');
      }
      expect(await audit('master_import.apply', run.body.id)).toHaveLength(1);
    } finally {
      await db.query(`UPDATE settings SET value = to_jsonb(50) WHERE key = 'imports.async_rows'`);
      jobs.autoStart = true;
    }
  });

  it('a stream template upload with the historical option holds nothing; without it the row is held', async () => {
    const t = await team(['B3', 'B4']);
    const held = await makeSite(db, R, { prefix: 'WLT' });
    const hist = await makeSite(db, R, { prefix: 'WLT' });
    for (const s of [held, hist]) { await makeTask(db, s, 'B3', 'open'); await makeTask(db, s, 'B4', 'locked'); }
    expect((await openWaiver(t.admin)).status).toBe(200);
    const plainUp = await uploadFile(t.admin.api, await filled(t.admin.api, 'TPL-SITE-CW', [{ 'Site ID': held.code, 'B4 CW Survey Actual': day('2026-02-10') }]), 'f.xlsx');
    expect([201, 202]).toContain(plainUp.status);
    const pr = (await t.admin.api.call('get', `/import-batches/${plainUp.body.id}/rows`)).body.items as { task_code: string; hold_reason: string | null }[];
    expect(pr.find((r) => r.task_code === 'B4')!.hold_reason).toBe('predecessor_open');
    expect(await locksOf(held.id)).toBe(true);

    const hUp = await uploadFile(t.admin.api, await filled(t.admin.api, 'TPL-SITE-CW', [{ 'Site ID': hist.code, 'B4 CW Survey Actual': day('2026-02-10') }]), 'f.xlsx', { historical_load_reason: REASON });
    expect([201, 202]).toContain(hUp.status);
    const hr = (await t.admin.api.call('get', `/import-batches/${hUp.body.id}/rows`)).body.items as { task_code: string; hold_reason: string | null; action: string }[];
    const h4 = hr.find((r) => r.task_code === 'B4')!;
    expect(h4.action).toBe('update');
    expect(h4.hold_reason ?? null).toBeNull();
    expect(await locksOf(hist.id)).toBe(false);
    const sites = await t.admin.api.call('get', `/import-batches/${hUp.body.id}/sites`);
    expect(sites.status).toBe(200);
    expect(sites.body.items).toEqual([expect.objectContaining({ site_id: hist.id, workflow_locks: false })]);
  });
});

describe('a new site created Open', () => {
  const SR = 7;
  let n = 0;
  const code = (): string => `WL${TAG}${String(++n).padStart(3, '0')}`;
  async function siteCell(kind: 'entry' | 'approve', users: string[]): Promise<void> {
    const level = kind === 'entry' ? 1 : 3;
    await db.query('DELETE FROM matrix_cells WHERE register_key = $1 AND level = $2 AND region_id = $3', ['site_creation', level, SR]);
    const c = await db.query(`INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ('site_creation', $1, 'any_one', $2, false, now()) RETURNING id`, [level, SR]);
    for (const u of users) await db.query(`INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, 'user', $2)`, [c.rows[0].id, u]);
  }
  const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);

  it('Open needs the right to unlock at the L2 approval; Locked is the default; an unknown value is refused', async () => {
    const l1 = await actor(app, db, { level: 'entry', regions: [SR], grants: [['sites', 'view'], ['sites', 'create']] });
    const l2 = await actor(app, db, { level: 'approve', regions: [SR], grants: [['sites', 'view'], ['sites', 'approve']] });
    await siteCell('entry', [l1.user.id]);
    await siteCell('approve', [l2.user.id]);
    const body = (over: Record<string, unknown>) => ({ site_code: code(), region_id: SR, name: 'Synthetic Site', delivery_scenario: 'new_build', ...over });

    expect((await l1.api.call('post', '/sites', body({ workflow_locks: 'Sometimes' }))).status).toBe(422);
    const send = async (b: Record<string, unknown>) => {
      const c = await l1.api.call('post', '/sites', b);
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      const s = await l1.api.call('post', `/site-drafts/${c.body.id}/submit`, undefined, { 'If-Match': etag(c) });
      expect(s.status).toBe(200);
      return s;
    };
    // the default: Locked
    const plainB = body({});
    const p = await send(plainB);
    expect((await l2.api.call('post', `/site-drafts/${p.body.id}/decide`, { action: 'approve' }, { 'If-Match': etag(p) })).status).toBe(200);
    expect((await q<{ l: boolean }>(db, 'SELECT workflow_locks AS l FROM sites WHERE site_code = $1', [plainB.site_code]))[0]!.l).toBe(true);

    // Open: the L2 without the right is refused (403), nothing is created
    const openB = body({ workflow_locks: 'Open' });
    const o = await send(openB);
    const refused = await l2.api.call('post', `/site-drafts/${o.body.id}/decide`, { action: 'approve' }, { 'If-Match': etag(o) });
    expect(refused.status).toBe(403);
    expect(await q(db, 'SELECT 1 FROM sites WHERE site_code = $1', [openB.site_code])).toHaveLength(0);
    // with the right (a delegation of unlock for the region) the site is created open, audited with the creation
    await delegate(db, l2.user.id, [['overrides.unlock', 'administer']], [SR]);
    const ok = await l2.api.call('post', `/site-drafts/${o.body.id}/decide`, { action: 'approve' }, { 'If-Match': etag(o) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const made = (await q<{ id: string; l: boolean }>(db, 'SELECT id, workflow_locks AS l FROM sites WHERE site_code = $1', [openB.site_code]))[0]!;
    expect(made.l).toBe(false);
    expect((await audit('site_workflow_locks_set', made.id)).at(-1)).toMatchObject({ after: { workflow_locks: false, source: 'site_create' }, actor_id: l2.user.id });
    expect((await q<{ n: string }>(db, `SELECT count(*)::text AS n FROM task_instances WHERE site_id = $1 AND state = 'locked'`, [made.id]))[0]!.n).not.toBe('0'); // milestones, dismantle, MOB stay locked
    expect((await q<{ n: string }>(db, `SELECT count(*)::text AS n FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id
      WHERE ti.site_id = $1 AND ti.state = 'locked' AND NOT td.is_milestone_task AND td.code !~ '^(E[0-9]|MOB-)'`, [made.id]))[0]!.n).toBe('0');
    // the New sites template carries the column
    const tpl = await q<{ cols: { code: string; options?: string[] }[] }>(db, `SELECT v.columns AS cols FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-NEW' AND v.is_current`);
    expect(tpl[0]!.cols.find((c) => c.code === 'workflow_locks')).toMatchObject({ options: ['Locked', 'Open'] });
  });
});
