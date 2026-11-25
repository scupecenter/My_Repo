import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import type { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { ImportJobsService } from '../src/templates/import-jobs.service';
import { Api, startApp, superDbHns } from './helpers';
import { day } from './tpl-helpers';
import { SITE_ENTRY_GRANTS } from './tpl-stream-helpers';
import { Actor, Site, actor, makeSite, makeTask, plainAdmin } from './wf-helpers';

/**
 * Migration 0126 (owner decision "Option 1", 2026-11-18): in the historical Master load approved directly, a task with no date in the owner's file is N/A
 * "historical load: no source" when the site moved past it (a transitive successor in the workflow is approved with an actual date); never a date invented.
 * The milestones then complete by their normal rule and the current stage follows. A site that did not move on keeps the task open; a task in review is
 * never touched; a live site is never touched; the mark is an admin override that the existing revert door restores; a re-apply whose file dates the task
 * restores and approves it. Its own database (TEST_DATABASE_URL_HNS): the catch-up reads every site of a historical load, and every re-apply discards every
 * open historical Master batch of its database. Synthetic data only. Region 4.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 4;
const REASON = 'Historical Master of the owner, with direct approval';

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_HNS as string });
  db = await superDbHns();
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
/** Uploads the file and applies it with the direct approval (and its register sheets); returns the run id. */
async function load(admin: Actor, file: Buffer, reapply = false): Promise<string> {
  const run = await uploadMaster(admin.api, file);
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  const applied = await admin.api.call('post', `/master-import/runs/${run.body.id}/apply`,
    { mode: 'submit', reason: 'Load', historical_load: { reason: REASON, approve_directly: true, registers: true, ...(reapply ? { reapply: true } : {}) } },
    { 'If-Match': `"${run.body.version}"` });
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  return run.body.id as string;
}
interface TaskRow { id: string; code: string; state: string; hns: boolean; hda: boolean; override: boolean; actual_date: string | null; na_reason: string | null }
const tasks = async (siteId: string): Promise<Record<string, TaskRow>> => Object.fromEntries((await q<TaskRow>(db,
  `SELECT t.id::text AS id, td.code, t.state::text AS state, t.historical_no_source AS hns, t.historical_direct_approved AS hda, t.admin_override AS override,
     t.actual_date::text AS actual_date, t.na_reason
   FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id WHERE t.site_id = $1`, [siteId])).map((r) => [r.code, r]));
const audits = async (action: string, siteId: string) => (await q<{ n: number }>(db,
  'SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND site_id = $2', [action, siteId]))[0]!.n;
const stage = async (siteId: string) => (await q<{ s: string }>(db, 'SELECT hns_current_stage($1) AS s', [siteId]))[0]!.s;
const catchUp = async () => (await q<{ r: Record<string, any> }>(db, 'SELECT hns_catch_up() AS r'))[0]!.r;

/** A site of the historical load: Design & Acquisition waiting for Site Release, the first PRE-CW tasks locked. Core: A5 is N/A by its rule (0124). */
async function site(prefix: string, a2 = 'locked'): Promise<Site> {
  const s = await makeSite(db, R, { prefix, status: 'not_started' });
  await makeTask(db, s, 'A1', 'open');
  await makeTask(db, s, 'A2', a2);
  for (const c of ['A3', 'A4', 'A5', 'MS1', 'B1', 'B2', 'B3', 'B4', 'MS2']) await makeTask(db, s, c, 'locked');
  await db.query(`UPDATE sites SET site_type = 'Core' WHERE id = $1`, [s.id]);
  return s;
}

const RF = ['#', 'Site ID', 'TSSR Approved', 'LLD Approved Date'];
const ACQ = ['#', 'Site ID', 'Candidate', 'Selected', 'Contract Sign-off Date'];

describe('0126: N/A "historical load: no source" where the site moved past the task', () => {
  let admin: Actor;
  let moved: Site; let still: Site; let review: Site; let redo: Site;

  it('the historical load approved directly: A1/A2/A4 and B1..B3 of a site with B4 approved become N/A (no source), MS1 completes, the current stage moves on; a site with no later work keeps A2/A4; a task in review is untouched', async () => {
    admin = await plainAdmin(app, db);
    moved = await site('HNM');
    still = await site('HNS');
    review = await site('HNR', 'in_review');
    redo = await site('HND');
    await openWaiver(admin);
    // the owner's file: no TSSR / LLD date (empty columns), the Acquisition date (A3), and for three sites a later CW date (B4, Master AO)
    const file = await masterFile([
      { A: 1, B: moved.code, AO: day('2026-02-10') }, { A: 2, B: still.code }, { A: 3, B: review.code, AO: day('2026-02-11') }, { A: 4, B: redo.code, AO: day('2026-02-12') },
    ], [
      { name: 'RF & Design', headers: RF, rows: [[1, moved.code, null, null], [2, still.code, null, null], [3, review.code, null, null], [4, redo.code, null, null]] },
      { name: 'Acquisition', headers: ACQ, rows: [[1, moved.code, 'A', 'Yes', day('2026-01-20')], [2, still.code, 'A', 'Yes', day('2026-01-21')],
        [3, review.code, 'A', 'Yes', day('2026-01-22')], [4, redo.code, 'A', 'Yes', day('2026-01-23')]] },
    ]);
    const runId = await load(admin, file);

    const m = await tasks(moved.id);
    expect(m.A3).toMatchObject({ state: 'approved', hda: true, actual_date: '2026-01-20' });
    expect(m.B4).toMatchObject({ state: 'approved', hda: true, actual_date: '2026-02-10' });
    for (const c of ['A1', 'A2', 'A4', 'B1', 'B2', 'B3']) {
      expect(m[c], c).toMatchObject({ state: 'na', hns: true, override: true, actual_date: null, na_reason: 'historical load: no source' });
    }
    expect(m.A5).toMatchObject({ state: 'na', hns: false });   // N/A by its own rule (Core), not by this one
    expect(m.MS1).toMatchObject({ state: 'approved', actual_date: '2026-01-20' });   // the date of A3: no date invented
    expect(await stage(moved.id)).not.toBe('MS1');
    // the evidence and the override: one audit row, one override row, one workflow step per task
    const au = await q<{ after: Record<string, any>; reason: string; is_admin_override: boolean; actor_id: string }>(db,
      `SELECT after, reason, is_admin_override, actor_id::text AS actor_id FROM audit_log WHERE action = 'task_historical_no_source_na' AND entity_id = $1`, [m.A2!.id]);
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({ is_admin_override: true, reason: REASON, actor_id: admin.user.id,
      after: { state: 'na', historical_no_source: true, reason_code: 'historical_no_source', task_code: 'A2', catch_up: false } });
    expect(['A4', 'A5', 'MS1', 'B1', 'B2', 'B3', 'B4', 'MS2', 'A3']).toContain(au[0]!.after.evidence_task);
    expect(await audits('task_historical_no_source_na', moved.id)).toBe(6);
    const ov = await q<{ kind: string; before: Record<string, any>; acted_by: string }>(db,
      `SELECT kind, before, acted_by::text AS acted_by FROM admin_overrides WHERE task_id = $1`, [m.A2!.id]);
    expect(ov).toEqual([{ kind: 'historical_no_source_na', before: { state: 'open' }, acted_by: admin.user.id }]);
    const sum = await q<{ after: Record<string, any>; is_admin_override: boolean }>(db,
      `SELECT after, is_admin_override FROM audit_log WHERE action = 'historical_no_source_apply' AND entity_id = $1`, [runId]);
    expect(sum).toHaveLength(1);
    expect(sum[0]).toMatchObject({ is_admin_override: true, after: { sites_in_scope: 4, tasks_na_by_code: { A2: 2, B1: 3 } } });
    expect(sum[0]!.after.current_stage_before.MS1).toBe(4);

    // a site with no later approved work: A3 is approved, so A1 (its predecessor) is N/A; A2 and A4 stay open (nothing after them is approved)
    const s = await tasks(still.id);
    expect(s.A1).toMatchObject({ state: 'na', hns: true });
    expect(s.A2!.state).toBe('open');   // its predecessor A1 is N/A now: it opens, it is not marked
    expect(s.A2!.hns).toBe(false);
    expect(s.A4!.hns).toBe(false);
    expect(['locked', 'open']).toContain(s.A4!.state);   // not N/A: nothing after it is approved
    expect(s.MS1!.state).not.toBe('approved');
    expect(await stage(still.id)).toBe('MS1');
    // a task in review keeps its L2 path; Site Release waits for it
    const r = await tasks(review.id);
    expect(r.A2).toMatchObject({ state: 'in_review', hns: false });
    expect(r.A4).toMatchObject({ state: 'na', hns: true });
    expect(r.MS1!.state).not.toBe('approved');
  });

  it('idempotent: the same file again and the catch-up mark nothing more', async () => {
    const n = await audits('task_historical_no_source_na', moved.id);
    const file = await masterFile([{ A: 1, B: moved.code, AO: day('2026-02-10') }], [
      { name: 'Acquisition', headers: ACQ, rows: [[1, moved.code, 'A', 'Yes', day('2026-01-20')]] },
    ]);
    await load(admin, file, true);
    const again = await catchUp();
    expect(again.tasks_na).toBe(0);
    expect(await audits('task_historical_no_source_na', moved.id)).toBe(n);
    expect((await tasks(moved.id)).A2).toMatchObject({ state: 'na', hns: true });
  });

  it('a re-apply whose file now dates the task restores it and approves it directly with that date', async () => {
    expect((await tasks(redo.id)).A2).toMatchObject({ state: 'na', hns: true });
    const file = await masterFile([{ A: 1, B: redo.code, AO: day('2026-02-12') }], [
      { name: 'RF & Design', headers: RF, rows: [[1, redo.code, day('2026-01-09'), null]] },
    ]);
    await load(admin, file, true);
    const t = await tasks(redo.id);
    expect(t.A2).toMatchObject({ state: 'approved', hda: true, hns: false, override: false, actual_date: '2026-01-09' });
    expect(t.A4).toMatchObject({ state: 'na', hns: true });   // still no date: still N/A
    expect(await audits('task_historical_no_source_restore', redo.id)).toBe(1);
    const ov = await q<{ reverted: boolean }>(db, `SELECT reverted_at IS NOT NULL AS reverted FROM admin_overrides WHERE task_id = $1`, [t.A2!.id]);
    expect(ov).toEqual([{ reverted: true }]);
  });

  it('restore: the revert of the override (System Admin, reason, step-up) puts the task back for the team; it is never marked again; others are refused', async () => {
    const m = await tasks(moved.id);
    const oid = (await q<{ id: string }>(db, `SELECT id::text AS id FROM admin_overrides WHERE task_id = $1 AND reverted_at IS NULL`, [m.A2!.id]))[0]!.id;
    // the task screen lists the override as revertible
    const detail = await admin.api.call('get', `/tasks/${m.A2!.id}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.overrides).toEqual(expect.arrayContaining([expect.objectContaining({ id: oid, kind: 'historical_no_source_na', revertible: true })]));
    const clerk = await actor(app, db, { level: 'entry', grants: SITE_ENTRY_GRANTS, regions: [R], modules: null });
    const denied = await clerk.api.call('post', `/overrides/${oid}/revert`, { reason: 'Not an admin' });
    expect([403, 404]).toContain(denied.status);
    const noStep = await plainAdmin(app, db, false);
    const ns = await noStep.api.call('post', `/overrides/${oid}/revert`, { reason: 'No step-up' });
    expect(ns.status).toBe(401);

    const rv = await admin.api.call('post', `/overrides/${oid}/revert`, { reason: 'The team has the TSSR approval date' });
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);
    expect(rv.body).toMatchObject({ kind: 'historical_no_source_na', revertible: false });
    expect(rv.body.reverted_at).toBeTruthy();
    const t = await tasks(moved.id);
    expect(t.A2).toMatchObject({ state: 'open', hns: false, override: false, na_reason: null });   // A1 is N/A: it opens for L1 at once
    expect(t.MS1!.state).toBe('approved');   // a calculated milestone is never taken back; it follows when A2 is approved
    expect(await audits('task_historical_no_source_restore', moved.id)).toBe(1);
    const st = await q<{ action: string; after_state: string }>(db,
      `SELECT action::text AS action, after_state::text AS after_state FROM workflow_steps WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`, [t.A2!.id]);
    expect(st[0]!.action).toBe('override_revert');
    const twice = await admin.api.call('post', `/overrides/${oid}/revert`, { reason: 'Again' });
    expect(twice.status).toBe(409);
    // a restored task is never marked again (catch-up and re-apply)
    expect((await catchUp()).tasks_na).toBe(0);
    expect((await tasks(moved.id)).A2).toMatchObject({ state: 'open', hns: false });
  });

  it('catch-up: a site of an earlier historical load is marked as its loader; a live site and a site with no historical approval are never touched', async () => {
    const hist = await makeSite(db, R, { prefix: 'HNC', status: 'in_progress' });
    const live = await makeSite(db, R, { prefix: 'HNL', status: 'in_progress' });
    for (const s of [hist, live]) {
      await makeTask(db, s, 'A1', 'approved', { actualDate: '2026-01-02' });
      await makeTask(db, s, 'A2', 'open');
      for (const c of ['A3', 'A4', 'A5']) await makeTask(db, s, c, 'na');
      await makeTask(db, s, 'MS1', 'locked');
      await makeTask(db, s, 'B1', 'approved', { actualDate: '2026-02-01' });
    }
    const tv = (await q<{ id: string }>(db, `SELECT v.id::text AS id FROM template_versions v JOIN template_definitions dd ON dd.id = v.template_def_id WHERE dd.template_id = 'TPL-ACQUISITION' AND v.is_current`))[0]!.id;
    // as an earlier load left them (fixture rows, triggers off): B1 of the historical site approved directly by a historical batch
    await db.query('SET session_replication_role = replica');
    try {
      const b = (await q<{ id: string }>(db, `INSERT INTO import_batches (template_version_id, source, file_name, file_sha256, status, uploaded_by, register_key, mode,
          historical_load, historical_cutoff, historical_reason, historical_marked_by, historical_marked_at, historical_direct_approve, closed_at)
        VALUES ($1, 'master_import', 'GSDN_Site_Master.xlsx', repeat('e', 64), 'approved', $2, 'acquisition', 'submit', true, '2026-06-30', $3, $2, now(), true, now()) RETURNING id::text AS id`,
        [tv, admin.user.id, REASON]))[0]!.id;
      await db.query(`UPDATE task_instances t SET historical_direct_approved = true, historical_direct_batch_id = $2, historical_direct_approved_at = now()
        FROM task_definitions td WHERE td.id = t.task_def_id AND td.code = 'B1' AND t.site_id = $1`, [hist.id, b]);
    } finally {
      await db.query('SET session_replication_role = origin');
    }
    const out = await catchUp();
    expect(out.tasks_na_by_code).toMatchObject({ A2: 1 });
    const h = await tasks(hist.id);
    expect(h.A2).toMatchObject({ state: 'na', hns: true, override: true });
    // every predecessor of Site Release is N/A, none has a date: MS1 opens but stays without a date (never invented), and it is reported
    expect(h.MS1!.state).toBe('open');
    expect(h.MS1!.actual_date).toBeNull();
    expect(out.milestones_without_date).toMatchObject({ MS1: 1 });
    const au = await q<{ actor_id: string; after: Record<string, any> }>(db,
      `SELECT actor_id::text AS actor_id, after FROM audit_log WHERE action = 'task_historical_no_source_na' AND site_id = $1`, [hist.id]);
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({ actor_id: admin.user.id, after: { catch_up: true, evidence_task: 'B1' } });
    const l = await tasks(live.id);
    expect(l.A2).toMatchObject({ state: 'open', hns: false, override: false });
    expect(await audits('task_historical_no_source_na', live.id)).toBe(0);
    const sum = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'historical_no_source_catch_up'`);
    expect(sum[0]!.n).toBeGreaterThanOrEqual(1);
    expect((await catchUp()).tasks_na).toBe(0);
  });

  it('in the background: the rule waits for the last background send of the file, then marks (hns_after_job)', async () => {
    const jobs = app.get(ImportJobsService);
    jobs.autoStart = false;
    await db.query(`UPDATE settings SET value = to_jsonb(2) WHERE key = 'imports.async_rows'`);
    try {
      const sites = [await site('HNB'), await site('HNB'), await site('HNB')];
      const file = await masterFile(sites.map((x, i) => ({ A: i + 1, B: x.code, AO: day('2026-02-15') })), [
        { name: 'Acquisition', headers: ACQ, rows: sites.map((x, i) => [i + 1, x.code, 'A', 'Yes', day('2026-01-25')]) },
      ]);
      const run = await uploadMaster(admin.api, file);
      expect(run.status, JSON.stringify(run.body)).toBe(201);
      const queued = await admin.api.call('post', `/master-import/runs/${run.body.id}/apply`,
        { mode: 'submit', reason: 'Load', historical_load: { reason: REASON, approve_directly: true, registers: true } }, { 'If-Match': `"${run.body.version}"` });
      expect(queued.status, JSON.stringify(queued.body)).toBe(202);
      const jobId = queued.body.applying.job_id as string;
      await jobs.process((await jobs.pending(0)).find((x) => x.apply && x.job_id === jobId)!);
      const done = await admin.api.call('get', `/master-import/runs/${run.body.id}`);
      const batches = done.body.outcome.batches as { id: string; queued?: boolean }[];
      expect(batches.some((b) => b.queued), JSON.stringify(batches)).toBe(true);
      // the CW rows are still being sent: nothing is marked yet
      expect((await tasks(sites[0]!.id)).A2!.hns).toBe(false);
      for (const b of batches) {
        if (b.queued) await jobs.process((await jobs.pending(0)).find((x) => x.batch_id === b.id)!);
      }
      for (const x of sites) {
        const t = await tasks(x.id);
        expect(t.B4).toMatchObject({ state: 'approved', actual_date: '2026-02-15' });
        expect(t.A2).toMatchObject({ state: 'na', hns: true });
        expect(t.MS1).toMatchObject({ state: 'approved', actual_date: '2026-01-25' });
      }
      const sum = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'historical_no_source_apply' AND entity_id = $1`, [run.body.id]);
      expect(sum[0]!.n).toBe(1);
    } finally {
      await db.query(`UPDATE settings SET value = to_jsonb(50) WHERE key = 'imports.async_rows'`);
      jobs.autoStart = true;
    }
  });

  it('the application role cannot reach the internal functions or write the flag; a forged flag is refused', async () => {
    const app2 = new (await import('pg')).Client({ connectionString: process.env.TEST_DATABASE_URL_HNS });
    await app2.connect();
    try {
      for (const sql of [`SELECT hns_catch_up()`, `SELECT hns_apply_sites(ARRAY[gen_random_uuid()], 'x', false, NULL)`,
        `SELECT hns_mark_site(gen_random_uuid(), gen_random_uuid(), 'x', false)`, `SELECT hns_restore_task(gen_random_uuid(), 'x', 'x', true)`,
        `SELECT hns_restore_dated('[]'::jsonb, 'x')`, `SELECT hns_site_in_scope(gen_random_uuid())`]) {
        await expect(app2.query(sql)).rejects.toThrow(/permission denied/);
      }
      await expect(app2.query(`UPDATE task_instances SET historical_no_source = true`)).rejects.toThrow(/permission denied/);
      await expect(app2.query(`INSERT INTO admin_overrides (entity, site_id, task_id, kind, reason, before, after, acted_by) SELECT 'task', site_id, id, 'historical_no_source_na', 'forged', '{}', '{}', gen_random_uuid() FROM task_instances LIMIT 1`)).rejects.toThrow(/permission denied/);
    } finally {
      await app2.end();
    }
    // even the definer owner cannot set the flag outside the rule (no marker): the guard refuses
    const t = (await q<{ id: string }>(db, `SELECT t.id::text AS id FROM task_instances t WHERE t.state = 'open' AND NOT t.historical_no_source LIMIT 1`))[0]!.id;
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE pmis_definer');
      await expect(db.query(`UPDATE task_instances SET state = 'na', is_na = true, historical_no_source = true, historical_no_source_at = now() WHERE id = $1`, [t]))
        .rejects.toThrow(/written only by GSDN Workspace/);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
