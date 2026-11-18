import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import type { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, startApp, superDbHrfix } from './helpers';
import { G, regCell } from './reg-helpers';
import { day } from './tpl-helpers';
import { SITE_APPROVE_GRANTS, SITE_ENTRY_GRANTS } from './tpl-stream-helpers';
import { Actor, Site, actor, makeSite, makeTask, plainAdmin, setCell } from './wf-helpers';

/**
 * Migration 0125 (owner report 2026-11-18, run f0274405): the historical Master load approved directly by a System Admin (1) sends and approves a dated row
 * whose task is not approved although it already holds the row's values, (2) is not stopped by the Matrix entry holder (L1) of a task or of a register row
 * (admin override, audited; the normal path still refuses), (3) keeps a register list value outside its list as typed, with a warning. With them, A2 and A4
 * come from the RF & Design sheet and Site Release (MS1) completes. Its own database (TEST_DATABASE_URL_HRFIX): every re-apply discards every open historical
 * Master batch of its database. Synthetic data only. Region 4.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 4;
const REASON = 'Historical Master of the owner, loaded again with direct approval';

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_HRFIX as string });
  db = await superDbHrfix();
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
/** Uploads the file and applies it; returns the outcome. */
async function load(admin: Actor, file: Buffer, hl: Record<string, unknown>): Promise<{ batches: Batch[]; discarded: { id: string }[] }> {
  const run = await uploadMaster(admin.api, file);
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  const applied = await admin.api.call('post', `/master-import/runs/${run.body.id}/apply`, { mode: 'submit', reason: 'Load', historical_load: { reason: REASON, ...hl } },
    { 'If-Match': `"${run.body.version}"` });
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  return applied.body.outcome;
}
interface Batch { id: string; kind: string; ref: string; approved: number; errors: number; skipped: number }
interface TaskRow { code: string; state: string; flag: boolean; actual_date: string | null; approves: number }
const tasks = async (siteId: string): Promise<Record<string, TaskRow>> => Object.fromEntries((await q<TaskRow>(db,
  `SELECT td.code, t.state::text AS state, t.historical_direct_approved AS flag, t.actual_date::text AS actual_date,
     (SELECT count(*)::int FROM workflow_steps w WHERE w.task_id = t.id AND w.action = 'approve') AS approves
   FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id WHERE t.site_id = $1`, [siteId])).map((r) => [r.code, r]));
interface BRow { site_code: string; task_code: string | null; action: string; decision: string; errors: { code: string; field?: string }[]; warnings: { code: string; field?: string; message: string }[] }
const rows = (batchId: string) => q<BRow>(db,
  `SELECT site_code, task_code, action, decision, coalesce(errors, '[]'::jsonb) AS errors, coalesce(warnings, '[]'::jsonb) AS warnings FROM import_batch_rows WHERE batch_id = $1 ORDER BY ord, row_no`, [batchId]);
const codes = (l: { code: string }[]) => l.map((x) => x.code);

/** The System Admin who loads, and the Matrix holders of the region who are NOT the admin: an L1 clerk of the tasks and registers, an L2 approver. */
async function people(): Promise<{ admin: Actor; clerk: Actor }> {
  const admin = await plainAdmin(app, db);
  const clerk = await actor(app, db, { level: 'entry', regions: [R], modules: null, grants: [...SITE_ENTRY_GRANTS,
    ...G('rf_design', 'view', 'create', 'edit'), ...G('acquisition', 'view', 'create', 'edit'), ...G('permits_hse', 'view', 'create', 'edit'), ...G('procurement', 'view', 'create', 'edit')] });
  const approver = await actor(app, db, { level: 'approve', regions: [R], modules: null, grants: [...SITE_APPROVE_GRANTS,
    ...G('rf_design', 'view', 'approve'), ...G('acquisition', 'view', 'approve'), ...G('permits_hse', 'view', 'approve'), ...G('procurement', 'view', 'approve')] });
  for (const c of ['A2', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4']) {
    await setCell(db, c, R, 'entry', { user: [clerk.user.id] });
    await setCell(db, c, R, 'approve', { user: [approver.user.id] });
  }
  for (const k of ['rf_design', 'acquisition', 'permits_hse', 'procurement']) {
    await regCell(db, k, R, 'entry', { user: [clerk.user.id] });
    await regCell(db, k, R, 'approve', { user: [approver.user.id] });
  }
  return { admin, clerk };
}

const RF = ['#', 'Site ID', 'TSSR Approved', 'LLD Approved Date', 'Cabinet Foundation (Existing / New)', 'RT or GF', 'Existing or New'];
const ACQ = ['#', 'Site ID', 'Candidate', 'Selected', 'Contract Sign-off Date'];
const PERM = ['#', 'Site ID', 'Type', 'Status', 'Valid From', 'Valid To'];
const PRPO = ['#', 'Site ID', 'Scope', 'PR No.', 'PR Date', 'PO / WO No.', 'PO / WO Date', 'Order Status'];

describe('0125: the historical direct approval is not stopped by the Matrix entry holder; Site Release completes', () => {
  it('normal path refuses (not_entry_holder, not_in_list); the re-apply with direct approval discards those batches, loads every sheet as the admin override, A2/A4/A3 approved, A5 N/A, MS1 done', async () => {
    const { admin, clerk } = await people();
    const s = await makeSite(db, R, { prefix: 'HFX', status: 'not_started' });
    await makeTask(db, s, 'A1', 'open');
    for (const c of ['A2', 'A3', 'A4', 'A5']) await makeTask(db, s, c, 'locked');
    await makeTask(db, s, 'MS1', 'locked');
    for (const c of ['B1', 'B2', 'B3']) await makeTask(db, s, c, 'locked');
    await db.query(`UPDATE sites SET site_type = 'Core' WHERE id = $1`, [s.id]);   // 0124: A5 is N/A on a site that is not HUB or Terminal
    await openWaiver(admin);
    const file = await masterFile([{ A: 1, B: s.code }], [
      { name: 'RF & Design', headers: RF, rows: [[1, s.code, day('2026-01-08'), day('2026-01-12'), 'Exist. 1.2x1.2', 'GF', 'New']] },
      { name: 'Acquisition', headers: ACQ, rows: [[1, s.code, 'A', 'Yes', day('2026-01-20')], [2, s.code, 'B', 'No', null]] },
      { name: 'Permission Log', headers: PERM, rows: [[1, s.code, 'Access - CW', 'Approved', day('2026-02-01'), day('2027-02-01')]] },
      { name: 'PR-PO', headers: PRPO, rows: [[1, s.code, 'CW', 'PR-HFX-1', day('2026-01-25'), 'PO-HFX-1', day('2026-01-28'), 'Closed']] },
    ]);

    // the normal path (historical load, no direct approval): the Matrix entry holder stops the admin, a value outside the list is refused
    const first = await load(admin, file, { registers: true });
    const fb = (ref: string) => first.batches.find((b) => b.ref === ref)!;
    expect(codes((await rows(fb('DESIGN_ACQ').id)).flatMap((r) => r.errors))).toEqual(['not_entry_holder', 'not_entry_holder']);
    for (const ref of ['permits_hse', 'procurement']) expect(codes((await rows(fb(ref).id)).flatMap((r) => r.errors)), ref).toEqual(['not_entry_holder']);
    expect(codes((await rows(fb('acquisition').id)).flatMap((r) => r.errors))).toContain('not_entry_holder');
    expect((await rows(fb('rf_design').id))[0]!.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'not_in_list', field: 'cabinet_foundation' })]));
    expect((await tasks(s.id)).A2!.state).not.toBe('approved');
    const open = await q<{ id: string; status: string }>(db, `SELECT id::text AS id, status FROM import_batches WHERE id = ANY ($1::uuid[])`, [first.batches.map((b) => b.id)]);
    const stillOpen = open.filter((b) => ['validated', 'in_review', 'in_approval', 'partially_approved'].includes(b.status)).map((b) => b.id);
    expect(stillOpen.length).toBeGreaterThan(0);

    // the same file again (a new run of the same SHA-256) with the direct approval and the re-apply: the open batches are discarded first
    const out = await load(admin, file, { registers: true, approve_directly: true, reapply: true });
    expect(out.discarded.map((d) => d.id).sort()).toEqual([...stillOpen].sort());
    const ob = (ref: string) => out.batches.find((b) => b.ref === ref)!;
    expect(ob('DESIGN_ACQ'), JSON.stringify(out.batches)).toMatchObject({ approved: 2, errors: 0 });
    for (const ref of ['rf_design', 'permits_hse', 'procurement']) expect(ob(ref), JSON.stringify(await rows(ob(ref).id))).toMatchObject({ approved: 1, errors: 0 });
    expect(ob('acquisition')).toMatchObject({ approved: 1, errors: 1 });   // the selected candidate still needs its Selection Date (Q468): A3 comes from Master T (0124)
    const da = await rows(ob('DESIGN_ACQ').id);
    for (const r of da) expect(codes(r.warnings), r.task_code ?? '').toContain('historical_entry_override');
    const rf = (await rows(ob('rf_design').id))[0]!;
    expect(codes(rf.warnings)).toEqual(['historical_entry_override', 'not_in_list_kept']);
    expect(rf.warnings[1]).toMatchObject({ field: 'cabinet_foundation' });
    expect(rf.warnings[1]!.message).toMatch(/"Exist\. 1\.2x1\.2" is not in the list ExistNew/);

    // the records: approved directly, the value outside the list kept as typed, the list values matched as before
    const rec = await q<{ state: string; flag: boolean; data: Record<string, unknown> }>(db,
      `SELECT state, historical_direct_approved AS flag, data FROM register_records WHERE register_key = 'rf_design' AND site_id = $1 AND is_current`, [s.id]);
    expect(rec[0]).toMatchObject({ state: 'approved', flag: true, data: { cabinet_foundation: 'Exist. 1.2x1.2', rt_or_gf: 'GF', existing_or_new: 'New', tssr_approved: '2026-01-08' } });
    for (const k of ['permits_hse', 'procurement', 'acquisition']) {
      const r = await q<{ state: string; flag: boolean }>(db, `SELECT state, historical_direct_approved AS flag FROM register_records WHERE register_key = $1 AND site_id = $2`, [k, s.id]);
      expect(r[0], k).toMatchObject({ state: 'approved', flag: true });
    }

    // the tasks: A2 / A4 from the RF & Design sheet, A3 from Master T, A5 N/A, Site Release complete; B1 / B2 / B3 fed by the registers (0123)
    const t = await tasks(s.id);
    expect(t.A2).toMatchObject({ state: 'approved', flag: true, actual_date: '2026-01-08', approves: 1 });
    expect(t.A4).toMatchObject({ state: 'approved', flag: true, actual_date: '2026-01-12', approves: 1 });
    expect(t.A3).toMatchObject({ state: 'approved', flag: true, actual_date: '2026-01-20', approves: 1 });
    expect(t.A5!.state).toBe('na');
    expect(t.MS1).toMatchObject({ state: 'approved', actual_date: '2026-01-20' });
    expect(t.B1).toMatchObject({ state: 'approved', flag: true, actual_date: '2026-01-25' });
    expect(t.B2).toMatchObject({ state: 'approved', flag: true, actual_date: '2026-01-28' });
    expect(t.B3).toMatchObject({ state: 'approved', flag: true, actual_date: '2026-02-01' });
    expect((await q<{ s: string }>(db, 'SELECT overall_status::text AS s FROM sites WHERE id = $1', [s.id]))[0]!.s).toBe('in_progress');

    // who entered: the admin (not the Matrix holder), audited as the admin override per batch; the Matrix is unchanged
    const a2 = (await q<{ id: string }>(db, `SELECT t.id::text AS id FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id WHERE td.code = 'A2' AND t.site_id = $1`, [s.id]))[0]!.id;
    const submit = await q<{ acted_by: string }>(db, `SELECT acted_by::text AS acted_by FROM workflow_steps WHERE task_id = $1 AND action = 'submit'`, [a2]);
    expect(submit[0]!.acted_by).toBe(admin.user.id);
    for (const ref of ['DESIGN_ACQ', 'rf_design', 'procurement']) {
      const au = await q<{ after: Record<string, any>; is_admin_override: boolean; reason: string; actor_id: string }>(db,
        `SELECT after, is_admin_override, reason, actor_id::text AS actor_id FROM audit_log WHERE action = 'import_batch.historical_entry_override' AND entity_id = $1`, [ob(ref).id]);
      expect(au, ref).toHaveLength(1);
      expect(au[0]).toMatchObject({ is_admin_override: true, reason: REASON, actor_id: admin.user.id });
      expect(au[0]!.after.rows_entry_override).toBeGreaterThanOrEqual(1);
    }
    expect((await q<{ after: Record<string, any> }>(db, `SELECT after FROM audit_log WHERE action = 'import_batch.historical_entry_override' AND entity_id = $1`,
      [ob('rf_design').id]))[0]!.after).toMatchObject({ values_kept_outside_list: 1 });
    const holders = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM matrix_cells c JOIN matrix_cell_assignees a ON a.cell_id = c.id
      JOIN task_definitions td ON td.id = c.task_def_id WHERE td.code = 'A2' AND c.level = 1 AND c.region_id = $1 AND a.ref_id = $2`, [R, clerk.user.id]);
    expect(holders[0]!.n).toBe(1);
    // the staging mark lives only inside the apply
    expect((await q<{ n: number }>(db, 'SELECT count(*)::int AS n FROM hrf_stage_marks'))[0]!.n).toBe(0);

    // once more (another run of the same file): nothing is approved twice
    const again = await load(admin, file, { registers: true, approve_directly: true, reapply: true });
    expect(again.batches.find((b) => b.ref === 'DESIGN_ACQ')).toMatchObject({ approved: 0, skipped: 2 });
    for (const [c, row] of Object.entries(await tasks(s.id))) expect(row.approves, c).toBeLessThanOrEqual(1);
  });
});

describe('0125: a dated row whose task already holds its values is sent and approved in the direct approval', () => {
  it('an earlier load left the values on the open task: unchanged without direct approval, approved directly with it; approved and N/A tasks stay', async () => {
    const { admin } = await people();
    const mk = async (state: string, d: string | null): Promise<{ site: Site; b4: string }> => {
      const site = await makeSite(db, R, { prefix: 'HFU', status: 'not_started' });
      await makeTask(db, site, 'MS1', 'approved', { actualDate: '2026-01-05' });
      await makeTask(db, site, 'B3', 'approved', { actualDate: '2026-01-20' });
      return { site, b4: await makeTask(db, site, 'B4', state, { actualDate: d }) };
    };
    const held = await mk('open', '2026-02-10');       // an earlier load or entry saved the date; nothing sent the task since
    const entry = await mk('entry', '2026-02-11');
    const done = await mk('approved', '2026-02-12');
    const na = await mk('na', null);
    await openWaiver(admin);
    const file = await masterFile([held, entry, done, na].map((x, i) => ({ A: i + 1, B: x.site.code, AO: day(['2026-02-10', '2026-02-11', '2026-02-12', '2026-02-13'][i]!) })), []);

    // without the direct approval (as the earlier loads): the rows are unchanged, the task stays open
    const first = await load(admin, file, {});
    const cw1 = await rows(first.batches.find((b) => b.ref === 'CW')!.id);
    expect(cw1.map((r) => r.action)).toEqual(['unchanged', 'unchanged', 'unchanged', 'unchanged']);
    expect((await tasks(held.site.id)).B4!.state).toBe('open');

    // the re-apply with the direct approval: the dated rows of the tasks that are not approved are sent and approved (admin override: not the L1 holder)
    const out = await load(admin, file, { approve_directly: true, reapply: true });
    const cw = out.batches.find((b) => b.ref === 'CW')!;
    expect(cw).toMatchObject({ approved: 2, errors: 0, skipped: 2 });
    const r2 = await rows(cw.id);
    for (const r of r2.slice(0, 2)) expect(codes(r.warnings)).toEqual(expect.arrayContaining(['historical_resend', 'historical_entry_override']));
    expect((await tasks(held.site.id)).B4).toMatchObject({ state: 'approved', flag: true, actual_date: '2026-02-10', approves: 1 });
    expect((await tasks(entry.site.id)).B4).toMatchObject({ state: 'approved', flag: true, actual_date: '2026-02-11', approves: 1 });
    expect((await tasks(done.site.id)).B4).toMatchObject({ state: 'approved', flag: false, actual_date: '2026-02-12', approves: 0 });   // never approved twice
    expect((await tasks(na.site.id)).B4).toMatchObject({ state: 'na', actual_date: null });
    const au = await q<{ after: Record<string, any> }>(db, `SELECT after FROM audit_log WHERE action = 'import_batch.historical_entry_override' AND entity_id = $1`, [cw.id]);
    expect(au[0]!.after).toMatchObject({ rows_resent: 2, rows_entry_override: 2 });
  });

  it('the application role cannot reach the internal functions or the staging mark', async () => {
    const app2 = new (await import('pg')).Client({ connectionString: process.env.TEST_DATABASE_URL_HRFIX });
    await app2.connect();
    try {
      for (const sql of [`SELECT hrf_staging()`, `SELECT hrf_override_ok(gen_random_uuid(), NULL, NULL)`, `SELECT hrf_note_batches(ARRAY[gen_random_uuid()], 'x')`,
        `SELECT count(*) FROM hrf_stage_marks`, `INSERT INTO hrf_stage_marks (xid, actor_id, run_id) VALUES (txid_current(), gen_random_uuid(), gen_random_uuid())`]) {
        await expect(app2.query(sql)).rejects.toThrow(/permission denied/);
      }
    } finally {
      await app2.end();
    }
  });
});
