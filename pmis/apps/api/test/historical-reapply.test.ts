import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import type { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, delegate, loggedIn, makeUser, startApp, superDbHrap } from './helpers';
import { day } from './tpl-helpers';
import { SITE_APPROVE_GRANTS } from './tpl-stream-helpers';
import { Actor, Site, actor, makeSite, makeTask, plainAdmin, setCell } from './wf-helpers';

/**
 * Migration 0122 (owner decision 2026-11-17, "Re-apply the file with direct approval"): a System Admin applies again a historical Master file that another run
 * already applied, with the direct approval; the open Master batches of the earlier loads are discarded first (audited), nothing is approved twice. And the
 * overall status of a site follows its milestones (the dashboard rule). Its own database (TEST_DATABASE_URL_HRAP): the re-apply discards every open historical
 * Master batch of the database. Synthetic data only. Region 6.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 6;
const REASON = 'Historical Master of the owner, loaded again with direct approval';

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_HRAP as string });
  db = await superDbHrap();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

type Cell = string | number | Date | null;
interface Sheet { name: string; headers: string[]; rows: Cell[][] }

/** A synthetic legacy Master: the Master sheet (three header rows, data from row 5) and the given register sheets (header row 1, data from row 3). */
async function masterFile(masterRows: Record<string, Cell>[], sheets: Sheet[]): Promise<Buffer> {
  const cols = await q<{ letter: string; group_top: string | null; group_mid: string | null; name: string | null }>(db, 'SELECT letter, group_top, group_mid, name FROM master_columns WHERE is_active ORDER BY ord');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Guide').getCell('A1').value = 'Guide';
  const ws = wb.addWorksheet('Master');
  for (const c of cols) {
    ws.getCell(`${c.letter}1`).value = c.group_top ?? null;
    ws.getCell(`${c.letter}2`).value = c.group_mid ?? null;
    ws.getCell(`${c.letter}3`).value = c.name ?? null;
  }
  masterRows.forEach((r, i) => {
    for (const [L, v] of Object.entries(r)) {
      const cell = ws.getCell(`${L}${5 + i}`);
      cell.value = v as ExcelJS.CellValue;
      if (v instanceof Date) cell.numFmt = 'yyyy-mm-dd';
    }
  });
  const st = wb.addWorksheet('Setting');
  st.getCell('I1').value = 'Project Staff';
  ['Name', 'Role', 'Region', 'Status'].forEach((h, i) => { st.getCell(2, 9 + i).value = h; });
  for (const s of sheets) {
    const sh = wb.addWorksheet(s.name);
    s.headers.forEach((h, i) => { sh.getCell(1, i + 1).value = h; });
    s.rows.forEach((r, k) => r.forEach((v, i) => {
      if (v === null) return;
      const cell = sh.getCell(3 + k, i + 1);
      cell.value = v as ExcelJS.CellValue;
      if (v instanceof Date) cell.numFmt = 'yyyy-mm-dd';
    }));
  }
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
const uploadMaster = (api: Api, buf: Buffer): request.Test => {
  const r = api.raw('post', '/master-import/runs');
  if (api.csrf) r.set('X-CSRF-Token', api.csrf);
  return r.attach('file', buf, { filename: 'GSDN_Site_Master.xlsx', contentType: 'application/octet-stream' });
};
const openWaiver = async (a: Actor) => {
  const r = await a.api.call('put', '/settings/historical-waiver', { open: true, cutoff_date: '2026-06-30', reason: 'Open for the historical load' });
  expect([200, 409]).toContain(r.status);
};
const audit = (action: string, entityId: string) =>
  q<{ before: Record<string, any> | null; after: Record<string, any> | null; reason: string | null; is_admin_override: boolean; actor_id: string | null }>(
    db, 'SELECT before, after, reason, is_admin_override, actor_id FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY id', [action, entityId]);
const task = async (id: string) => (await q<{ state: string; flag: boolean; batch: string | null; actual_date: string | null; approves: number }>(db,
  `SELECT t.state::text AS state, t.historical_direct_approved AS flag, t.historical_direct_batch_id::text AS batch, t.actual_date::text AS actual_date,
     (SELECT count(*)::int FROM workflow_steps w WHERE w.task_id = t.id AND w.action = 'approve') AS approves
   FROM task_instances t WHERE t.id = $1`, [id]))[0]!;
const status = async (siteId: string) => (await q<{ s: string }>(db, 'SELECT overall_status::text AS s FROM sites WHERE id = $1', [siteId]))[0]!.s;

const RF_HEADERS = ['#', 'Site ID', 'TSSR Approved', 'LLD Approved Date'];

describe('0122: re-apply a historical Master file with direct approval', () => {
  it('refuses without the right person, step-up, waiver, reason or direct approval; with them it discards the open batches, loads every stream, never approves twice', async () => {
    const admin = await plainAdmin(app, db);
    const approver = await actor(app, db, { level: 'approve', grants: SITE_APPROVE_GRANTS, regions: [R], modules: null });
    for (const c of ['B4', 'A2', 'A4']) {
      await setCell(db, c, R, 'entry', { user: [admin.user.id] });
      await setCell(db, c, R, 'approve', { user: [approver.user.id] });
    }
    // three sites: S1 is sent by the first load and approved later by its L2 (as on the server); S2 waits for an earlier submission; S3 stays with L2
    const mk = async (b4State: string): Promise<{ site: Site; b4: string; a2: string; a4: string }> => {
      const site = await makeSite(db, R, { prefix: 'HRP', status: 'not_started' });
      await makeTask(db, site, 'MS1', 'approved', { actualDate: '2026-01-05' });
      await makeTask(db, site, 'B3', 'approved', { actualDate: '2026-01-20' });
      return { site, b4: await makeTask(db, site, 'B4', b4State), a2: await makeTask(db, site, 'A2', 'locked'), a4: await makeTask(db, site, 'A4', 'locked') };
    };
    const s1 = await mk('open');
    const s2 = await mk('in_review');
    const s3 = await mk('open');
    await openWaiver(admin);
    // one file, built once (the same bytes, the same SHA-256, for every upload)
    const file = await masterFile([
      { A: 1, B: s1.site.code, AO: day('2026-02-10') }, { A: 2, B: s2.site.code, AO: day('2026-02-11') }, { A: 3, B: s3.site.code, AO: day('2026-02-12') },
    ], [{ name: 'RF & Design', headers: RF_HEADERS, rows: [[1, s1.site.code, day('2026-01-08'), day('2026-01-12')]] }]);

    // the first load (as on 2026-11-11: historical, no direct approval): S1 and S3 sent to L2, S2 held
    const r1 = await uploadMaster(admin.api, file);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const a1 = await admin.api.call('post', `/master-import/runs/${r1.body.id}/apply`, { mode: 'submit', reason: 'First load', historical_load: { reason: REASON } },
      { 'If-Match': `"${r1.body.version}"` });
    expect(a1.status, JSON.stringify(a1.body)).toBe(200);
    const old = (a1.body.outcome.batches as { id: string; ref: string }[]).find((b) => b.ref === 'CW')!;
    expect((await q<{ s: string }>(db, 'SELECT status AS s FROM import_batches WHERE id = $1', [old.id]))[0]!.s).toBe('in_approval');
    // S1 is approved later by its L2 outside the batch (its row stays pending, as the rows of the server)
    await db.query(`UPDATE task_instances SET state = 'approved', approved_date = current_date, current_level = 3 WHERE id = $1`, [s1.b4]);
    expect(await status(s1.site.id)).toBe('in_progress');
    const s1Before = await task(s1.b4);

    // the same file again: a plain apply is refused, and says so
    const r2 = await uploadMaster(admin.api, file);
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    expect(r2.body.file_sha256).toBe(r1.body.file_sha256);
    expect(r2.body.applied_before).toMatchObject({ run_id: r1.body.id });
    const url = `/master-import/runs/${r2.body.id}/apply`;
    const im = { 'If-Match': `"${r2.body.version}"` };
    const plain = await admin.api.call('post', url, { mode: 'submit', reason: 'Again', historical_load: { reason: REASON, approve_directly: true } }, im);
    expect(plain.status, JSON.stringify(plain.body)).toBe(409);
    expect(plain.body).toMatchObject({ code: 'invalid_transition', already_applied: true, applied_run_id: r1.body.id });
    // refusals: reapply without approve_directly (422), outside historical_load (422), no reason (422)
    expect((await admin.api.call('post', url, { mode: 'submit', reason: 'Again', historical_load: { reason: REASON, reapply: true } }, im)).status).toBe(422);
    expect((await admin.api.call('post', url, { mode: 'submit', reason: 'Again', reapply: true }, im)).status).toBe(422);
    expect((await admin.api.call('post', url, { mode: 'submit', reason: 'Again', historical_load: { reason: '', reapply: true, approve_directly: true } }, im)).status).toBe(422);
    // a delegate of the import (not a System Admin): 403
    const dg = await makeUser(db, { assigned: true });
    await delegate(db, dg.id, [['templates', 'view'], ['templates', 'administer'], ['templates', 'import'], ['sites', 'view'], ['sites', 'edit']]);
    const dgApi = await loggedIn(app, dg);
    await dgApi.stepUp(dg.password);
    const body = { mode: 'submit', reason: 'Again', historical_load: { reason: REASON, approve_directly: true, registers: true, reapply: true } };
    expect((await dgApi.call('post', url, body, im)).status).toBe(403);
    // a System Admin without a step-up: 401
    const cold = await plainAdmin(app, db, false);
    expect((await cold.api.call('post', url, body, im)).status).toBe(401);
    // the waiver closed: 409
    expect((await admin.api.call('put', '/settings/historical-waiver', { open: false, reason: 'Closed for a moment' })).status).toBe(200);
    expect((await admin.api.call('post', url, body, im)).status).toBe(409);
    await openWaiver(admin);
    // nothing moved
    expect((await q<{ s: string }>(db, 'SELECT status AS s FROM import_batches WHERE id = $1', [old.id]))[0]!.s).toBe('in_approval');
    expect((await task(s3.b4)).state).toBe('in_approval');

    // the re-apply
    const ok = await admin.api.call('post', url, body, im);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const out = ok.body.outcome;
    expect(out).toMatchObject({ reapply: true, approve_directly: true, registers: true });
    // the open batch of the first load is discarded (audited, admin override); its unsent row (S2) is rejected, its sent row of S3 keeps its L2 path
    expect(out.discarded).toEqual([expect.objectContaining({ id: old.id, stream_code: 'CW', status_before: 'in_approval', rows_rejected: 1, rows_sent_open: 1 })]);
    const ob = await q<{ status: string; closed: boolean; note: string }>(db, 'SELECT status, closed_at IS NOT NULL AS closed, note FROM import_batches WHERE id = $1', [old.id]);
    expect(ob[0]).toMatchObject({ status: 'discarded', closed: true });
    const da = await audit('import_batch.discarded_for_reapply', old.id);
    expect(da).toHaveLength(1);
    expect(da[0]).toMatchObject({ is_admin_override: true, reason: REASON, actor_id: admin.user.id, before: { status: 'in_approval' },
      after: { status: 'discarded', reapply_run_id: r2.body.id, rows_rejected: 1, rows_sent_open: 1 } });
    const oldRows = await q<{ site_code: string; decision: string; note: string | null }>(db,
      'SELECT site_code, decision, decision_note AS note FROM import_batch_rows WHERE batch_id = $1 ORDER BY row_no', [old.id]);
    expect(oldRows.find((r) => r.site_code === s2.site.code)).toMatchObject({ decision: 'rejected' });
    expect(oldRows.find((r) => r.site_code === s2.site.code)!.note).toMatch(/^discarded: /);

    // S1: approved before, never approved again (the row changes nothing); S2 and S3 keep their L2 path (held: an open submission)
    expect(await task(s1.b4)).toEqual(s1Before);
    expect((await task(s1.b4)).flag).toBe(false);
    expect((await task(s2.b4)).state).toBe('in_review');
    expect((await task(s3.b4)).state).toBe('in_approval');
    const cw = (out.batches as { id: string; ref: string; kind: string }[]).find((b) => b.ref === 'CW')!;
    const cwRows = await q<{ site_code: string; action: string; decision: string; hold: string | null }>(db,
      'SELECT site_code, action, decision, hold_reason AS hold FROM import_batch_rows WHERE batch_id = $1', [cw.id]);
    expect(cwRows.find((r) => r.site_code === s1.site.code)).toMatchObject({ action: 'unchanged' });
    // S3 holds the same date in its open submission (the row changes nothing); S2 waits for its earlier submission (held, open_submission)
    expect(cwRows.find((r) => r.site_code === s3.site.code)).toMatchObject({ action: 'unchanged' });
    expect(cwRows.find((r) => r.site_code === s2.site.code)).toMatchObject({ decision: 'pending_previous_approval', hold: 'open_submission' });

    // the Design & Acquisition stream now loads: A2 and A4 from the RF & Design sheet, approved directly (admin override)
    const dab = (out.batches as { id: string; ref: string; approved: number }[]).find((b) => b.ref === 'DESIGN_ACQ');
    expect(dab, JSON.stringify(out.batches)).toBeDefined();
    expect(dab!.approved).toBe(2);
    expect(await task(s1.a2)).toMatchObject({ state: 'approved', flag: true, batch: dab!.id, actual_date: '2026-01-08' });
    expect(await task(s1.a4)).toMatchObject({ state: 'approved', flag: true, batch: dab!.id, actual_date: '2026-01-12' });
    expect((await q<{ s: string }>(db, `SELECT status AS s FROM import_batches WHERE id = $1`, [(out.batches as { id: string; ref: string }[]).find((b) => b.ref === 'rf_design')!.id]))[0]!.s).toBe('approved');
    // the run audit row names the re-apply
    expect((await audit('master_import.apply', r2.body.id))[0]!.after).toMatchObject({ reapply: true, approve_directly: true });

    // the re-applied run is applied: it is never applied again
    expect((await admin.api.call('post', url, body, { 'If-Match': `"${(await admin.api.call('get', `/master-import/runs/${r2.body.id}`)).body.version}"` })).status).toBe(409);
    // a second identical re-apply (another upload of the same file) changes nothing: no task approved again
    const directBefore = (await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'task_historical_direct_approval'`))[0]!.n;
    const r3 = await uploadMaster(admin.api, file);
    expect(r3.status, JSON.stringify(r3.body)).toBe(201);
    const again = await admin.api.call('post', `/master-import/runs/${r3.body.id}/apply`, body, { 'If-Match': `"${r3.body.version}"` });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect((await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'task_historical_direct_approval'`))[0]!.n).toBe(directBefore);
    expect(await task(s1.a2)).toMatchObject({ state: 'approved', flag: true, batch: dab!.id });
    expect(await task(s1.b4)).toEqual(s1Before);
    for (const b of again.body.outcome.batches as { id: string; kind: string; approved: number }[]) expect(b.approved ?? 0).toBe(0);
  });

  it('in the background (0086): the re-apply choice is stored on the run and the discard happens inside the background apply', async () => {
    const jobs = app.get((await import('../src/templates/import-jobs.service')).ImportJobsService);
    jobs.autoStart = false;
    await db.query(`UPDATE settings SET value = to_jsonb(1) WHERE key = 'imports.async_rows'`);
    try {
      const admin = await plainAdmin(app, db);
      await setCell(db, 'B4', R, 'entry', { user: [admin.user.id] });
      const sites: Site[] = [];
      const b4s: string[] = [];
      for (let i = 0; i < 2; i++) {
        const site = await makeSite(db, R, { prefix: 'HRQ', status: 'not_started' });
        await makeTask(db, site, 'MS1', 'approved', { actualDate: '2026-01-05' });
        await makeTask(db, site, 'B3', 'approved', { actualDate: '2026-01-20' });
        b4s.push(await makeTask(db, site, 'B4', i === 0 ? 'in_review' : 'open'));
        sites.push(site);
      }
      await openWaiver(admin);
      const file = await masterFile(sites.map((s, i) => ({ A: i + 1, B: s.code, AO: day('2026-02-15') })), []);
      // an earlier historical load of this file, left open (the held row of the in-review task keeps its batch open)
      const r1 = await uploadMaster(admin.api, file);
      const q1 = await admin.api.call('post', `/master-import/runs/${r1.body.id}/apply`, { mode: 'submit', reason: 'First load', historical_load: { reason: REASON } },
        { 'If-Match': `"${r1.body.version}"` });
      expect(q1.status, JSON.stringify(q1.body)).toBe(202);
      await jobs.process((await jobs.pending(0)).find((x) => x.apply && x.job_id === q1.body.applying.job_id)!);
      for (const b of (await admin.api.call('get', `/master-import/runs/${r1.body.id}`)).body.outcome.batches as { id: string; queued?: boolean }[]) {
        if (b.queued) await jobs.process((await jobs.pending(0)).find((x) => x.batch_id === b.id)!);
      }
      const open1 = await q<{ id: string }>(db, `SELECT id::text AS id FROM import_batches WHERE source = 'master_import' AND file_sha256 = $1 AND status IN ('validated', 'in_approval')`,
        [r1.body.file_sha256]);
      expect(open1.length).toBeGreaterThan(0);
      // the re-apply of the same file, queued
      const r2 = await uploadMaster(admin.api, file);
      const queued = await admin.api.call('post', `/master-import/runs/${r2.body.id}/apply`,
        { mode: 'submit', reason: 'Again', historical_load: { reason: REASON, approve_directly: true, reapply: true } }, { 'If-Match': `"${r2.body.version}"` });
      expect(queued.status, JSON.stringify(queued.body)).toBe(202);
      const jobId = queued.body.applying.job_id as string;
      expect((await q<{ reapply: boolean }>(db, 'SELECT reapply FROM mi_apply_jobs WHERE id = $1', [jobId]))[0]!.reapply).toBe(true);
      // nothing is discarded by the request itself
      for (const b of open1) expect((await q<{ s: string }>(db, 'SELECT status AS s FROM import_batches WHERE id = $1', [b.id]))[0]!.s).not.toBe('discarded');
      await jobs.process((await jobs.pending(0)).find((x) => x.apply && x.job_id === jobId)!);
      const done = await admin.api.call('get', `/master-import/runs/${r2.body.id}`);
      expect(done.body).toMatchObject({ status: 'applied', applying: { state: 'done' }, outcome: { reapply: true, approve_directly: true } });
      for (const b of open1) expect((await q<{ s: string }>(db, 'SELECT status AS s FROM import_batches WHERE id = $1', [b.id]))[0]!.s).toBe('discarded');
      for (const b of done.body.outcome.batches as { id: string; queued?: boolean }[]) {
        if (b.queued) await jobs.process((await jobs.pending(0)).find((x) => x.batch_id === b.id)!);
      }
      // the tasks keep their own path: the one sent by the first load stays with its L2, the in-review one is held again; nothing was approved twice
      expect((await task(b4s[1]!)).state).toBe('in_approval');
      expect((await task(b4s[0]!)).state).toBe('in_review');
      expect((await audit('import_batch.discarded_for_reapply', open1[0]!.id))[0]).toMatchObject({ is_admin_override: true, after: { reapply_run_id: r2.body.id } });
    } finally {
      await db.query(`UPDATE settings SET value = to_jsonb(50) WHERE key = 'imports.async_rows'`);
      jobs.autoStart = true;
    }
  });

  it('the application role cannot reach the internal functions or write the re-apply mark', async () => {
    const app2 = new (await import('pg')).Client({ connectionString: process.env.TEST_DATABASE_URL_HRAP });
    await app2.connect();
    try {
      for (const sql of [`SELECT hrp_discard_open(NULL::master_reconciliation_runs, 'x')`, `SELECT site_status_refresh(gen_random_uuid())`,
        `SELECT site_status_derive(gen_random_uuid())`]) {
        await expect(app2.query(sql)).rejects.toThrow(/permission denied/);
      }
      await expect(app2.query(`UPDATE mi_apply_jobs SET reapply = true`)).rejects.toThrow(/permission denied/);
    } finally {
      await app2.end();
    }
  });
});

describe('0122: the overall status of a site follows its milestones', () => {
  const approve = (id: string, d: string) => db.query(`UPDATE task_instances SET state = 'approved', actual_date = $2::date, approved_date = $2::date, current_level = 3 WHERE id = $1`, [id, d]);

  it('not_started, then in_progress (a task approved), then completed (the final milestone); the site map, Site Master, the sites list and the dashboard follow', async () => {
    const admin = await plainAdmin(app, db);
    const s = await makeSite(db, R, { prefix: 'OST', status: 'not_started' });
    const b4 = await makeTask(db, s, 'B4', 'open');
    const ms10 = await makeTask(db, s, 'MS10', 'open');
    expect(await status(s.id)).toBe('not_started');
    await approve(b4, '2026-02-01');
    expect(await status(s.id)).toBe('in_progress');
    // the screens that read the stored status
    const map = await admin.api.call('get', '/dashboard/site-map');
    expect(map.status).toBe(200);
    expect((map.body.items as { site_code: string; overall_status: string }[]).find((x) => x.site_code === s.code)).toMatchObject({ overall_status: 'in_progress' });
    const s360 = await admin.api.call('get', `/site360/master/rows?site_code=${s.code}`);
    expect(s360.status).toBe(200);
    expect(s360.body.rows[0].values['182']).toBe('in_progress');
    const list = await admin.api.call('get', `/sites?overall_status=in_progress&q=${s.code}`);
    expect(list.status).toBe(200);
    expect((list.body.items as { site_code: string }[]).map((x) => x.site_code)).toContain(s.code);
    // the dashboard derives the same status (a task approved, no milestone done)
    const dash = await admin.api.call('get', `/sites?dashboard_status=in_progress&region_id=${R}&q=${s.code}`);
    expect(dash.status, JSON.stringify(dash.body)).toBe(200);
    expect((dash.body.items as { site_code: string }[]).map((x) => x.site_code)).toContain(s.code);
    // the final milestone done: completed
    await approve(ms10, '2026-03-01');
    expect(await status(s.id)).toBe('completed');
    expect(((await admin.api.call('get', '/dashboard/site-map')).body.items as { site_code: string; overall_status: string }[]).find((x) => x.site_code === s.code))
      .toMatchObject({ overall_status: 'completed' });
    // the final milestone reopened: back to in_progress
    await db.query(`UPDATE task_instances SET state = 'open', actual_date = NULL, approved_date = NULL WHERE id = $1`, [ms10]);
    expect(await status(s.id)).toBe('in_progress');
  });

  it('hold and resume (Change Control) and cancellation stay as their flows set them; a withdrawn cancellation is derived again', async () => {
    const s = await makeSite(db, R, { prefix: 'OSH', status: 'not_started' });
    const b4 = await makeTask(db, s, 'B4', 'open');
    await approve(b4, '2026-02-01');
    expect(await status(s.id)).toBe('in_progress');
    const by = (await q<{ id: string }>(db, `SELECT id::text AS id FROM users LIMIT 1`))[0]!.id;
    const code = s.code.slice(-8);
    // an approved suspension: on_hold
    await db.query(`INSERT INTO change_requests (change_code, site_id, region_id, kind, status, approval_date, is_global, requested_by) VALUES
      ($1, $2, $3, 'suspension', 'approved', cal_today() - 10, false, $4)`, [`HS-${code}`, s.id, R, by]);
    expect(await status(s.id)).toBe('on_hold');
    // the resumption after it: in_progress again
    await db.query(`INSERT INTO change_requests (change_code, site_id, region_id, kind, status, approval_date, is_global, requested_by) VALUES
      ($1, $2, $3, 'resumption', 'approved', cal_today() - 5, false, $4)`, [`HR-${code}`, s.id, R, by]);
    expect(await status(s.id)).toBe('in_progress');
    // cancelled: kept whatever the tasks do
    await db.query(`UPDATE sites SET overall_status = 'cancelled' WHERE id = $1`, [s.id]);
    await db.query(`UPDATE task_instances SET state = 'open', actual_date = NULL, approved_date = NULL WHERE id = $1`, [b4]);
    await approve(b4, '2026-02-02');
    expect(await status(s.id)).toBe('cancelled');
    // the cancellation withdrawn with a stale earlier status (0062 restores the status before it): derived again
    await db.query(`UPDATE sites SET overall_status = 'not_started' WHERE id = $1`, [s.id]);
    expect(await status(s.id)).toBe('in_progress');
  });
});
