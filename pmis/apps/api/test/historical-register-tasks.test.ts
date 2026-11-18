import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import type { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, startApp, superDbHrtk } from './helpers';
import { day } from './tpl-helpers';
import { SITE_APPROVE_GRANTS } from './tpl-stream-helpers';
import { Actor, Site, actor, makeSite, makeTask, plainAdmin, setCell } from './wf-helpers';

/**
 * Migration 0123 (owner report 2026-11-18): the register records of the historical Master load approved directly (0093 / 0122) now close the tasks they are
 * the source of (Q43: A3, B1, B2, B3, C1, C2, C4, D1, D17, Z1; C3 by Q150), with the record's date, approved directly as the admin override of the load; the
 * milestones, the current stage and the overall status follow. A one-time catch-up does the same for the records already loaded. Its own database
 * (TEST_DATABASE_URL_HRTK): the catch-up reads every register record approved directly by a historical load of its database. Synthetic data only. Region 3.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 3;
const REASON = 'Historical Master of the owner, its registers close their tasks';

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_HRTK as string });
  db = await superDbHrtk();
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
interface TaskRow { code: string; state: string; flag: boolean; batch: string | null; actual_date: string | null; approves: number; lock_bypassed: boolean }
const tasks = async (siteId: string): Promise<Record<string, TaskRow>> => Object.fromEntries((await q<TaskRow>(db,
  `SELECT td.code, t.state::text AS state, t.historical_direct_approved AS flag, t.historical_direct_batch_id::text AS batch, t.actual_date::text AS actual_date,
     (SELECT count(*)::int FROM workflow_steps w WHERE w.task_id = t.id AND w.action = 'approve') AS approves, t.lock_bypassed
   FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id WHERE t.site_id = $1`, [siteId])).map((r) => [r.code, r]));
const directAudits = async (siteId: string) => (await q<{ n: number }>(db,
  `SELECT count(*)::int AS n FROM audit_log WHERE action = 'task_historical_direct_approval' AND site_id = $1`, [siteId]))[0]!.n;
const status = async (siteId: string) => (await q<{ s: string }>(db, 'SELECT overall_status::text AS s FROM sites WHERE id = $1', [siteId]))[0]!.s;

/** The tasks of the first stages of a site as a historical load finds them: the Master sheet entered A2, A4, B4 to B7, B10, B11 and B13; the register-fed tasks are open. */
async function loadedSite(prefix: string, siteReleased = false): Promise<Site> {
  const s = await makeSite(db, R, { prefix, status: 'not_started' });
  await makeTask(db, s, 'A1', 'open');                                  // no source in the file
  await makeTask(db, s, 'A2', 'approved', { actualDate: '2026-01-08' });
  await makeTask(db, s, 'A3', siteReleased ? 'approved' : 'locked', { actualDate: siteReleased ? '2026-01-20' : null });
  await makeTask(db, s, 'A4', 'approved', { actualDate: '2026-01-12' });
  await makeTask(db, s, 'MS1', siteReleased ? 'approved' : 'locked', { actualDate: siteReleased ? '2026-01-20' : null });
  for (const c of ['B1', 'B2', 'B3']) await makeTask(db, s, c, 'locked');
  await makeTask(db, s, 'B5', 'approved', { actualDate: '2026-02-11' });
  await makeTask(db, s, 'B6', 'approved', { actualDate: '2026-02-12' });
  await makeTask(db, s, 'B7', 'approved', { actualDate: '2026-02-14' });
  await makeTask(db, s, 'MS2', 'locked');
  await makeTask(db, s, 'B10', 'approved', { actualDate: '2026-03-01' });
  await makeTask(db, s, 'B11', 'approved', { actualDate: '2026-03-02' });
  // B10 and B11 were approved while PRE-CW was not done: Gate G3 holds CW Completion (wf_unlock_successors), released when it opens (calc_release_gated)
  const ms3 = await makeTask(db, s, 'MS3', 'locked');
  await db.query(`UPDATE task_instances SET lock_reason = 'gate_closed:G3' WHERE id = $1`, [ms3]);
  await makeTask(db, s, 'B13', 'approved', { actualDate: '2026-03-05' });
  await makeTask(db, s, 'C1', 'locked');
  await makeTask(db, s, 'C2', 'locked');
  await makeTask(db, s, 'MS4', 'locked');
  await makeTask(db, s, 'D1', 'locked');
  await makeTask(db, s, 'MS5', 'locked');
  return s;
}

const ACQ = ['#', 'Site ID', 'Candidate', 'Selected', 'Contract Sign-off Date'];
const PRPO = ['#', 'Site ID', 'Scope', 'PR No.', 'PR Date', 'PO / WO No.', 'PO / WO Date', 'Order Status'];
const PERM = ['#', 'Site ID', 'Type', 'Status', 'Valid From', 'Valid To'];
const GEC = ['#', 'Site ID', 'GECOL PR No.', 'Power-On Date (Meter Charging)'];

describe('0123: the register records of the historical load close their tasks', () => {
  it('with direct approval: B1, B2, B3 and D1 approved directly with the record dates, the milestones complete in order, the current stage moves; nothing twice', async () => {
    const admin = await plainAdmin(app, db);
    const approver = await actor(app, db, { level: 'approve', grants: SITE_APPROVE_GRANTS, regions: [R], modules: null });
    await setCell(db, 'B4', R, 'entry', { user: [admin.user.id] });
    await setCell(db, 'B4', R, 'approve', { user: [approver.user.id] });
    const s = await loadedSite('HRT', true);
    await makeTask(db, s, 'B4', 'open');
    // a second site whose B3 was approved earlier in the normal way: never approved again
    const s2 = await loadedSite('HRU', true);
    await db.query(`UPDATE task_instances t SET state = 'approved', actual_date = '2026-01-30', approved_date = '2026-01-30', current_level = 3
      FROM task_definitions td WHERE td.id = t.task_def_id AND td.code = 'B3' AND t.site_id = $1`, [s2.id]);
    await openWaiver(admin);
    const file = await masterFile([{ A: 1, B: s.code, AO: day('2026-02-10') }, { A: 2, B: s2.code, AO: day('2026-02-10') }], [
      { name: 'PR-PO', headers: PRPO, rows: [[1, s.code, 'CW', 'PR-HRT-1', day('2026-01-25'), 'PO-HRT-1', day('2026-01-28'), 'Closed']] },
      { name: 'Permission Log', headers: PERM, rows: [
        [1, s.code, 'Access - CW', 'Approved', day('2026-02-01'), day('2027-02-01')],
        [2, s.code, 'Access - TE', 'Approved', day('2026-04-01'), day('2027-04-01')],
        [3, s2.code, 'Access - CW', 'Approved', day('2026-02-03'), day('2027-02-03')],
        [4, s.code, 'PTW - CW', 'Approved', day('2026-02-01'), day('2027-02-01')],   // Gate G3 waits for both CW permits (not a task source)
      ] },
      // the owner's file has no Selection Date and no GECOL Request Date column: a selected candidate and a GECOL row are refused by their register rules
      { name: 'Acquisition', headers: ACQ, rows: [[1, s.code, 'A', 'Yes', day('2026-01-20')]] },
      { name: 'GECOL', headers: GEC, rows: [[1, s.code, 'GP-1', day('2026-03-03')]] },
    ]);
    const run = await uploadMaster(admin.api, file);
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const applied = await admin.api.call('post', `/master-import/runs/${run.body.id}/apply`,
      { mode: 'submit', reason: 'Initial load', historical_load: { reason: REASON, approve_directly: true, registers: true } }, { 'If-Match': `"${run.body.version}"` });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const batches = applied.body.outcome.batches as { id: string; kind: string; ref: string; approved: number; errors: number }[];
    const by = (ref: string) => batches.find((b) => b.ref === ref)!;
    expect(by('procurement'), JSON.stringify(batches)).toMatchObject({ kind: 'register', approved: 1, errors: 0 });
    expect(by('permits_hse')).toMatchObject({ kind: 'register', approved: 4, errors: 0 });
    const refused = await q<{ key: string; fields: string[] }>(db, `SELECT b.register_key AS key, array_agg(e ->> 'field' ORDER BY e ->> 'field') AS fields
      FROM import_batch_rows r JOIN import_batches b ON b.id = r.batch_id, jsonb_array_elements(r.errors) e
      WHERE b.id = ANY ($1::uuid[]) AND r.action = 'error' GROUP BY 1`, [[by('acquisition').id, by('gecol').id]]);
    expect(Object.fromEntries(refused.map((x) => [x.key, x.fields]))).toMatchObject({
      acquisition: expect.arrayContaining(['selection_date']), gecol: expect.arrayContaining(['request_date']) });

    const t = await tasks(s.id);
    // the fed tasks: approved directly (the flag and the register batch), the record's date, one approval each
    expect(t.B1).toMatchObject({ state: 'approved', flag: true, batch: by('procurement').id, actual_date: '2026-01-25', approves: 1 });
    expect(t.B2).toMatchObject({ state: 'approved', flag: true, batch: by('procurement').id, actual_date: '2026-01-28', approves: 1 });
    expect(t.B3).toMatchObject({ state: 'approved', flag: true, batch: by('permits_hse').id, actual_date: '2026-02-01', approves: 1 });
    expect(t.D1).toMatchObject({ state: 'approved', flag: true, batch: by('permits_hse').id, actual_date: '2026-04-01', approves: 1 });
    expect(t.D1!.lock_bypassed).toBe(true);   // its predecessor (Site RFI) is not done: the open site bypassed the lock (0085)
    // no source: left open, never given a date
    expect(t.A1).toMatchObject({ state: 'open', actual_date: null });
    expect(t.C2).toMatchObject({ state: 'open', actual_date: null });
    // the milestones complete in order with the dates of their conditions
    expect(t.MS2).toMatchObject({ state: 'approved', actual_date: '2026-02-14' });
    expect(t.MS3).toMatchObject({ state: 'approved' });
    // Site RFI is a milestone entered and approved by hand (Q38): nothing approves it here
    expect(t.MS4).toMatchObject({ state: 'open', flag: false });   // open for entry on the open site; entered and approved by hand (Q38)

    // the audit row of a fed task: admin override, the reason of the load, the record and its register; the record is linked to the first task it closed
    const pr = (await q<{ id: string; task_id: string | null }>(db,
      `SELECT id::text AS id, task_id::text AS task_id FROM register_records WHERE register_key = 'procurement' AND site_id = $1`, [s.id]))[0]!;
    const b1id = (await q<{ id: string }>(db,
      `SELECT t.id::text AS id FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id WHERE td.code = 'B1' AND t.site_id = $1`, [s.id]))[0]!.id;
    expect(pr.task_id).toBe(b1id);
    const au = await q<{ before: Record<string, any>; after: Record<string, any>; reason: string; is_admin_override: boolean; actor_id: string }>(db,
      `SELECT before, after, reason, is_admin_override, actor_id::text AS actor_id FROM audit_log WHERE action = 'task_historical_direct_approval' AND entity_id = $1`, [b1id]);
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({ is_admin_override: true, reason: REASON, actor_id: admin.user.id,
      before: { historical_direct_approved: false }, after: { historical_direct_approved: true, register_key: 'procurement', task_code: 'B1', source_field: 'pr_date',
        register_record_id: pr.id, catch_up: false } });
    const step = await q<{ note: string; acted_by: string }>(db, `SELECT note, acted_by::text AS acted_by FROM workflow_steps WHERE task_id = $1 AND action = 'approve'`, [b1id]);
    expect(step[0]!.note).toMatch(/^historical load: approved directly with the register record procurement /);
    expect(step[0]!.acted_by).toBe(admin.user.id);
    // the record's own audit row lists the tasks it fed
    const ra = await q<{ after: Record<string, any> }>(db, `SELECT after FROM audit_log WHERE action = 'register_record_historical_direct_approval' AND entity_id = $1`, [pr.id]);
    expect((ra[0]!.after.tasks_fed as { task_code: string; outcome: string }[]).map((x) => `${x.task_code}:${x.outcome}`)).toEqual(['B1:approved', 'B2:approved']);

    // the current stage and the overall status are the real ones
    const list = await admin.api.call('get', `/sites?q=${s.code}`);
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({ current_milestone: 'MS3', next_milestone: 'MS4', overall_status: 'in_progress' });
    expect(await status(s.id)).toBe('in_progress');

    // S2: B3 approved before is never approved again (its permit lands on the register row only)
    const t2 = await tasks(s2.id);
    expect(t2.B3).toMatchObject({ state: 'approved', flag: false, actual_date: '2026-01-30', approves: 0 });
    const p2 = await q<{ task_id: string | null; state: string }>(db,
      `SELECT task_id::text AS task_id, state FROM register_records WHERE register_key = 'permits_hse' AND site_id = $1`, [s2.id]);
    expect(p2[0]).toMatchObject({ state: 'approved', task_id: null });

    // the same file applied again (re-apply): its rows change nothing, no task is approved a second time; the catch-up after it changes nothing either
    const before = [await directAudits(s.id), await directAudits(s2.id)];
    const r2 = await uploadMaster(admin.api, file);
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    const again = await admin.api.call('post', `/master-import/runs/${r2.body.id}/apply`,
      { mode: 'submit', reason: 'Again', historical_load: { reason: REASON, approve_directly: true, registers: true, reapply: true } }, { 'If-Match': `"${r2.body.version}"` });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    await db.query('SELECT hrt_catch_up()');
    expect([await directAudits(s.id), await directAudits(s2.id)]).toEqual(before);
    for (const [c, row] of Object.entries(await tasks(s.id))) expect(row.approves, c).toBeLessThanOrEqual(1);
  });

  it('the one-time catch-up: records already approved directly by an earlier load close their tasks; kept paths and closed tasks stay; a second run changes nothing', async () => {
    const admin = await plainAdmin(app, db);
    const s = await loadedSite('HRC');
    for (const c of ['C4', 'D17']) await makeTask(db, s, c, 'locked');
    // C2 has its own submission waiting for L2: it keeps its path
    await db.query(`UPDATE task_instances t SET state = 'in_review', current_level = 2 FROM task_definitions td WHERE td.id = t.task_def_id AND td.code = 'C2' AND t.site_id = $1`, [s.id]);
    // the open site of a historical load (0085): the locked tasks are open for entry
    await db.query(`UPDATE task_instances t SET state = 'open', current_level = 1 FROM task_definitions td
      WHERE td.id = t.task_def_id AND t.site_id = $1 AND t.state = 'locked' AND NOT td.is_milestone_task`, [s.id]);
    // as 0093 / 0122 left them: register records approved directly by a register batch of the historical load, linked to no task (fixture rows, triggers off)
    const tv = (await q<{ id: string }>(db, `SELECT v.id::text AS id FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-MASTER' AND v.is_current`))[0]!.id;
    const recs: Record<string, string> = {};
    await db.query(`SET session_replication_role = replica`);
    try {
      for (const [key, data] of [
        ['acquisition', { candidate: 'A', selected: 'Yes', contract_signoff_date: '2026-01-19' }],
        ['procurement', { scope: 'Site Adaption', pr_no: 'PR-C-1', pr_date: '2026-01-24', po_wo_no: 'PO-C-1', po_wo_date: '2026-01-27' }],
        ['permits_hse', { permit_type: 'Access - CW', status: 'Approved', valid_from: '2026-01-31', valid_to: '2027-01-31', has_expiry: true }],
        ['permits_hse', { permit_type: 'PTW - CW', status: 'Approved', valid_from: '2026-01-31', valid_to: '2027-01-31', has_expiry: true }],
        ['gecol', { request_date: '2026-02-20', power_on_date: '2026-03-02' }],
        ['hlc', { in_service_date: '2026-03-04' }],
        ['readiness_handover', { om_acceptance_date: '2099-01-01' }],   // a date in the future closes nothing
      ] as [string, Record<string, string>][]) {
        const b = await q<{ id: string }>(db, `INSERT INTO import_batches (template_version_id, source, file_name, file_sha256, status, uploaded_by, register_key, mode,
            historical_load, historical_cutoff, historical_reason, historical_marked_by, historical_marked_at, historical_direct_approve, closed_at)
          VALUES ($1, 'master_import', 'GSDN_Site_Master.xlsx', repeat('c', 64), 'approved', $2, $3, 'submit', true, '2026-06-30', $4, $2, now(), true, now()) RETURNING id::text AS id`,
          [tv, admin.user.id, key, REASON]);
        const r = await q<{ id: string }>(db, `INSERT INTO register_records (entity_id, version_no, register_key, site_id, region_id, state, is_current, data, approved_at, approved_by,
            current_level, levels_required, historical_direct_approved, historical_direct_batch_id, historical_direct_approved_at)
          VALUES (gen_random_uuid(), 1, $1, $2, $3, 'approved', true, $4::jsonb, now(), $5, 3, 3, true, $6, now()) RETURNING id::text AS id`,
          [key, s.id, R, JSON.stringify(data), admin.user.id, b[0]!.id]);
        recs[`${key}:${String(data.permit_type ?? '')}`] = r[0]!.id;
      }
    } finally {
      await db.query(`SET session_replication_role = origin`);
    }
    for (const id of Object.values(recs)) await db.query('SELECT reg_apply($1::uuid)', [id]);   // their typed rows (the gates read the permits)
    const out = (await q<{ r: Record<string, any> }>(db, 'SELECT hrt_catch_up() AS r'))[0]!.r;
    expect(out.records).toBeGreaterThanOrEqual(7);
    expect(out.approved_by_task).toMatchObject({ A3: 1, B1: 1, B2: 1, B3: 1, C1: 1, C4: 1 });
    const t = await tasks(s.id);
    expect(t.A3).toMatchObject({ state: 'approved', flag: true, actual_date: '2026-01-19', approves: 1 });
    expect(t.B1).toMatchObject({ state: 'approved', flag: true, actual_date: '2026-01-24' });
    expect(t.B2).toMatchObject({ state: 'approved', flag: true, actual_date: '2026-01-27' });
    expect(t.B3).toMatchObject({ state: 'approved', flag: true, actual_date: '2026-01-31' });
    expect(t.C1).toMatchObject({ state: 'approved', flag: true, actual_date: '2026-02-20' });
    expect(t.C4).toMatchObject({ state: 'approved', flag: true, actual_date: '2026-03-04' });
    expect(t.C2).toMatchObject({ state: 'in_review', flag: false });          // its own submission keeps its L2 path
    expect(t.D17).toMatchObject({ state: 'open', actual_date: null });          // a future date closes nothing
    expect(t.MS1).toMatchObject({ state: 'approved', actual_date: '2026-01-19' });
    expect(t.MS2!.state).toBe('approved');
    expect(t.MS3!.state).toBe('approved');
    expect(await status(s.id)).toBe('in_progress');
    // the records are linked to the first task they closed
    const link = await q<{ key: string; task: string | null }>(db, `SELECT r.register_key AS key, td.code AS task FROM register_records r
      LEFT JOIN task_instances t ON t.id = r.task_id LEFT JOIN task_definitions td ON td.id = t.task_def_id WHERE r.id = ANY ($1::uuid[])`, [Object.values(recs)]);
    expect(link.map((x) => `${x.key}:${x.task ?? '-'}`).sort()).toEqual(['acquisition:A3', 'gecol:C1', 'hlc:C4', 'permits_hse:-', 'permits_hse:B3', 'procurement:B1', 'readiness_handover:-']);
    // the audit rows: one per task, admin override, the loader, the catch-up named; one summary row per run
    const au = await q<{ after: Record<string, any>; is_admin_override: boolean; actor_id: string }>(db,
      `SELECT after, is_admin_override, actor_id::text AS actor_id FROM audit_log WHERE action = 'task_historical_direct_approval' AND site_id = $1`, [s.id]);
    expect(au).toHaveLength(6);
    for (const a of au) expect(a).toMatchObject({ is_admin_override: true, actor_id: admin.user.id, after: { catch_up: true } });
    const sum = await q<{ after: Record<string, any>; is_admin_override: boolean }>(db,
      `SELECT after, is_admin_override FROM audit_log WHERE action = 'historical_register_tasks_catch_up' ORDER BY id DESC LIMIT 1`);
    expect(sum[0]).toMatchObject({ is_admin_override: true, after: { approved_by_task: { A3: 1 } } });
    // a second run changes nothing
    const n = await directAudits(s.id);
    const second = (await q<{ r: Record<string, any> }>(db, 'SELECT hrt_catch_up() AS r'))[0]!.r;
    expect(second.approved_by_task).toEqual({});
    expect(await directAudits(s.id)).toBe(n);
  });

  it('the application role cannot reach the internal functions or write the task flag', async () => {
    const app2 = new (await import('pg')).Client({ connectionString: process.env.TEST_DATABASE_URL_HRTK });
    await app2.connect();
    try {
      for (const sql of [`SELECT hrt_catch_up()`, `SELECT hrt_feed_record(gen_random_uuid(), gen_random_uuid(), true, 'x')`,
        `SELECT hrt_feed_task(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), current_date, 'A3', 'x', true, 'x')`]) {
        await expect(app2.query(sql)).rejects.toThrow(/permission denied/);
      }
      await expect(app2.query(`UPDATE task_instances SET historical_direct_approved = true`)).rejects.toThrow(/permission denied/);
    } finally {
      await app2.end();
    }
  });
});
