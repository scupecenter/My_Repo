import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import type { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { ImportJobsService } from '../src/templates/import-jobs.service';
import { Api, delegate, loggedIn, makeUser, startApp, superDbHreg } from './helpers';
import { day } from './tpl-helpers';
import { SITE_APPROVE_GRANTS } from './tpl-stream-helpers';
import { Actor, Site, actor, makeSite, makeTask, plainAdmin, setCell } from './wf-helpers';

/**
 * Migration 0088 (owner decision 2026-11-12, "Everything from the one file"): the historical Master apply also loads the register sheets of the same file
 * (RF & Design, Acquisition, Permission Log, PR-PO, GECOL, HLC, As-Built, Risk Register) into their registers; with approve_directly they are approved at once
 * (admin override, no L2). Its own database (TEST_DATABASE_URL_HREG; the seeded Document Library is off). Synthetic data only. Region 4.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 4;
const REASON = 'Historical registers of the owner Master, entered as they are';

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_HREG as string });
  db = await superDbHreg();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

type Cell = string | number | Date | null;
interface Sheet { name: string; headerRow?: number; firstRow?: number; headers: string[]; rows: Cell[][] }

/** A synthetic legacy Master: the Master sheet (as the real file: three header rows, data from row 5) and the given register sheets. */
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
    const hr = s.headerRow ?? 1;
    s.headers.forEach((h, i) => { sh.getCell(hr, i + 1).value = h; });
    s.rows.forEach((r, k) => r.forEach((v, i) => {
      if (v === null) return;
      const cell = sh.getCell((s.firstRow ?? 3) + k, i + 1);
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
async function team(): Promise<{ admin: Actor; approver: Actor }> {
  const admin = await plainAdmin(app, db);
  const approver = await actor(app, db, { level: 'approve', grants: SITE_APPROVE_GRANTS, regions: [R], modules: null });
  for (const c of ['B3', 'B4']) {
    await setCell(db, c, R, 'entry', { user: [admin.user.id] });
    await setCell(db, c, R, 'approve', { user: [approver.user.id] });
  }
  return { admin, approver };
}
async function preCwSite(prefix: string): Promise<{ site: Site; b4: string }> {
  const site = await makeSite(db, R, { prefix });
  await makeTask(db, site, 'MS1', 'approved', { actualDate: '2026-01-05' });
  await makeTask(db, site, 'B3', 'approved', { actualDate: '2026-01-20' });
  const b4 = await makeTask(db, site, 'B4', 'open');
  return { site, b4 };
}
const audit = (action: string, entityId: string) =>
  q<{ before: Record<string, any> | null; after: Record<string, any> | null; reason: string | null; is_admin_override: boolean; actor_id: string | null }>(
    db, 'SELECT before, after, reason, is_admin_override, actor_id FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY id', [action, entityId]);
const records = (key: string, siteId: string | null, riskId?: string) => q<{ id: string; state: string; flag: boolean; batch: string | null; data: Record<string, any>; is_current: boolean;
  approved_by: string | null; task_id: string | null; record_type: string | null }>(db,
  `SELECT id::text AS id, state, historical_direct_approved AS flag, historical_direct_batch_id::text AS batch, data, is_current, approved_by::text AS approved_by,
     task_id::text AS task_id, record_type FROM register_records
   WHERE register_key = $1 AND ($2::uuid IS NULL OR site_id = $2::uuid) AND ($3::text IS NULL OR data ->> 'risk_id' = $3) ORDER BY version_no`, [key, siteId, riskId ?? null]);

const RF_HEADERS = ['#', 'Site ID', 'Site Owner ID', 'Latitude', 'Tower Height (m)', 'Nominal Plan Issue Date (RFNP)', 'TSS Actual', 'Remark'];
const ACQ_HEADERS = ['#', 'Site ID', 'Candidate', 'Selected', 'Owner / Landlord', 'Contact Person', 'Phone', 'E-mail', 'Negotiation Start Date', 'Remark'];
const RSK_HEADERS = ['Risk ID', 'Risk Statement', 'Status', 'Target Date'];

describe('0088: the register sheets of the historical Master load', () => {
  it('approve directly: the register rows are records approved at once (admin override, no L2), flagged, audited; personal columns are never read; an unknown site is an error row; a missing sheet is skipped', async () => {
    const t = await team();
    const a = await preCwSite('HRA');
    const b = await makeSite(db, R, { prefix: 'HRA' });
    await openWaiver(t.admin);
    const rid = `risk-${a.site.code.toLowerCase()}`;
    const file = await masterFile([{ A: 1, B: a.site.code, AO: day('2026-02-10') }], [
      { name: 'RF & Design', headers: RF_HEADERS, rows: [
        [1, ` ${a.site.code.toLowerCase()} `, 'OWN-1', '32.5', '30', '05/03/2026', 'N/A', 'Fake  remark'],   // trimmed, numbers and a day-first date from text
        [2, 'ZZ-UNKNOWN-1', 'OWN-2', 31, 20, null, null, null],                                              // an unknown site: an error row
        [3, b.code, 'OWN-3', 30.1, 25, day('2026-02-01'), null, null],
      ] },
      { name: 'Acquisition', headers: ACQ_HEADERS, rows: [
        [1, a.site.code, 'a', 'n', 'Fake Landlord One', 'Fake Contact', '0910000000', 'landlord@example.test', day('2026-01-15'), 'Signed'],
      ] },
      { name: 'Risk Register', firstRow: 2, headers: RSK_HEADERS, rows: [[rid, 'A synthetic risk', null, day('2026-05-01')]] },
    ]);
    const run = await uploadMaster(t.admin.api, file);
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const applied = await t.admin.api.call('post', `/master-import/runs/${run.body.id}/apply`,
      { mode: 'submit', reason: 'Initial load', historical_load: { reason: REASON, approve_directly: true, registers: true } }, { 'If-Match': `"${run.body.version}"` });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const out = applied.body.outcome;
    expect(out).toMatchObject({ approve_directly: true, registers: true });
    const batches = out.batches as { id: string; kind: string; ref: string; sheet: string; rows: number; approved: number; errors: number; skipped: number }[];
    const rf = batches.find((x) => x.ref === 'rf_design')!;
    expect(rf).toMatchObject({ kind: 'register', sheet: 'RF & Design', rows: 3, approved: 2, errors: 1, skipped: 0 });
    expect(batches.find((x) => x.ref === 'acquisition')).toMatchObject({ kind: 'register', rows: 1, approved: 1, errors: 0 });
    expect(batches.find((x) => x.ref === 'risks')).toMatchObject({ kind: 'register', rows: 1, approved: 1, errors: 0 });
    // the stream batch of the Master sheet comes first and is approved directly as before (0087)
    expect(batches[0]!.kind).toBe('stream');
    expect((await q<{ s: string }>(db, 'SELECT state::text AS s FROM task_instances WHERE id = $1', [a.b4]))[0]!.s).toBe('approved');
    // the sheets the file does not have are skipped with their reason
    const skipped = out.skipped as { sheet: string; ref: string; reason: string }[];
    for (const s of ['Permission Log', 'PR-PO', 'GECOL', 'HLC', 'As-Built']) expect(skipped).toContainEqual(expect.objectContaining({ sheet: s, reason: 'sheet_missing' }));
    expect((out.register_notes as { code: string; sheet: string; count: number }[])).toContainEqual(expect.objectContaining({ sheet: 'RF & Design', code: 'date_day_first_assumed', count: 1 }));

    // the records: approved, the version in force, the flag, the mapping and the normalisation
    const [rfa] = await records('rf_design', a.site.id);
    expect(rfa).toMatchObject({ state: 'approved', flag: true, batch: rf.id, is_current: true, approved_by: t.admin.user.id, task_id: null });
    expect(rfa!.data).toMatchObject({ site_owner_id: 'OWN-1', latitude: 32.5, tower_height: 30, nominal_plan_issue_date: '2026-03-05', remark: 'Fake remark' });
    expect(rfa!.data.tss_actual).toBeUndefined();   // N/A in a date cell is blank
    expect((await records('rf_design', b.id))[0]).toMatchObject({ state: 'approved', flag: true });
    const steps = await q<{ action: string; note: string | null; acted_by: string; stepup_verified: boolean; batch_row_id: string | null }>(db,
      'SELECT action, note, acted_by::text AS acted_by, stepup_verified, batch_row_id::text AS batch_row_id FROM register_steps WHERE record_id = $1 ORDER BY created_at', [rfa!.id]);
    expect(steps.map((s) => s.action)).toEqual(['create', 'submit', 'approve']);
    expect(steps[2]).toMatchObject({ note: 'historical load: approved directly (admin override)', acted_by: t.admin.user.id, stepup_verified: true });
    expect(steps[2]!.batch_row_id).not.toBeNull();
    const au = await audit('register_record_historical_direct_approval', rfa!.id);
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({ is_admin_override: true, reason: REASON, actor_id: t.admin.user.id,
      before: { historical_direct_approved: false, state: 'in_approval' }, after: { historical_direct_approved: true, state: 'approved', register_key: 'rf_design' } });
    // personal columns (Q469) are never read: no landlord, contact, phone or e-mail on the record
    const [acq] = await records('acquisition', a.site.id);
    expect(acq).toMatchObject({ state: 'approved', flag: true });
    expect(acq!.data).toMatchObject({ candidate: 'A', selected: 'No', negotiation_start_date: '2026-01-15', remark: 'Signed' });
    for (const k of ['owner_landlord', 'contact_person', 'phone', 'email']) expect(acq!.data[k]).toBeUndefined();
    const leaked = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM import_batch_rows WHERE payload::text ~* '(Fake Landlord|0910000000|landlord@example|Fake Contact)'`);
    expect(leaked[0]!.n).toBe(0);
    // a historical record is approved on its register row only: the A3 source task is not linked (its dates come from the Master sheet)
    expect(acq!.task_id).toBeNull();
    // the Risk Register is not site-scoped: the key is the Risk ID (trimmed, upper case)
    expect((await records('risks', null, rid.toUpperCase()))[0]).toMatchObject({ state: 'approved', flag: true });

    // the error row of the unknown site, in its own batch; the batch is approved (its other rows) and closed
    const rows = (await t.admin.api.call('get', `/import-batches/${rf.id}/rows?limit=50`)).body.items as { site_code: string; action: string; decision: string; errors: { code: string }[] }[];
    expect(rows.find((r) => r.site_code === 'ZZ-UNKNOWN-1')).toMatchObject({ action: 'error' });
    expect(rows.find((r) => r.site_code === 'ZZ-UNKNOWN-1')!.errors.map((e) => e.code)).toContain('site_not_in_scope');
    const bt = await q<{ status: string; source: string; historical_load: boolean; hda: boolean; group_id: string; closed: boolean }>(db,
      `SELECT status, source, historical_load, historical_direct_approve AS hda, group_id::text AS group_id, closed_at IS NOT NULL AS closed FROM import_batches WHERE id = $1`, [rf.id]);
    expect(bt[0]).toMatchObject({ status: 'approved', source: 'master_import', historical_load: true, hda: true, group_id: out.group_id, closed: true });
    expect((await audit('import_batch.historical_direct_approval', rf.id))[0]).toMatchObject({ is_admin_override: true });
    // no notice about records that are already approved (no "waits for you", no "no holder")
    const notes = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM notifications WHERE link LIKE '/registers/%/records/' || $1`, [rfa!.id]);
    expect(notes[0]!.n).toBe(0);
    // the record DTO shows the flag (the Admin override badge)
    const dto = await t.admin.api.call('get', `/registers/rf_design/records/${rfa!.id}`);
    expect(dto.status, JSON.stringify(dto.body)).toBe(200);
    expect(dto.body.historical_direct_approved).toBe(true);

    // the flag is written by no other path, and clears (audited) if the record leaves the approved state
    await db.query(`UPDATE register_records SET state = 'voided' WHERE id = $1`, [rfa!.id]);
    expect((await records('rf_design', a.site.id))[0]!.flag).toBe(false);
    expect(await audit('register_record_historical_direct_approval_cleared', rfa!.id)).toHaveLength(1);
  });

  it('without approve_directly the register rows are sent and wait for L2 as a normal register batch', async () => {
    const t = await team();
    const a = await preCwSite('HRB');
    await openWaiver(t.admin);
    const file = await masterFile([{ A: 1, B: a.site.code, AO: day('2026-02-10') }], [
      { name: 'RF & Design', headers: RF_HEADERS, rows: [[1, a.site.code, 'OWN-9', 32, 30, null, null, null]] },
    ]);
    const run = await uploadMaster(t.admin.api, file);
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const applied = await t.admin.api.call('post', `/master-import/runs/${run.body.id}/apply`,
      { mode: 'submit', reason: 'Initial load', historical_load: { reason: REASON, registers: true } }, { 'If-Match': `"${run.body.version}"` });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.outcome).toMatchObject({ approve_directly: false, registers: true });
    const rf = (applied.body.outcome.batches as { id: string; ref: string; approved: number; submitted: number }[]).find((x) => x.ref === 'rf_design')!;
    expect(rf).toMatchObject({ approved: 0, submitted: 1 });
    const [rec] = await records('rf_design', a.site.id);
    expect(['in_review', 'in_approval']).toContain(rec!.state);
    expect(rec!.flag).toBe(false);
    const bt = await q<{ status: string; historical_load: boolean; hda: boolean }>(db,
      'SELECT status, historical_load, historical_direct_approve AS hda FROM import_batches WHERE id = $1', [rf.id]);
    expect(bt[0]).toMatchObject({ status: 'in_approval', historical_load: true, hda: false });
    expect(await audit('register_record_historical_direct_approval', rec!.id)).toHaveLength(0);
  });

  it('in the background: a big apply (0086) keeps the register rows on its run, and a big register batch is sent in chunks (0075), approved directly', async () => {
    const jobs = app.get(ImportJobsService);
    jobs.autoStart = false;
    await db.query(`UPDATE settings SET value = to_jsonb(2) WHERE key = 'imports.async_rows'`);
    try {
      const t = await team();
      const sites = [await preCwSite('HRC'), await preCwSite('HRC'), await preCwSite('HRC')];
      await openWaiver(t.admin);
      const file = await masterFile(sites.map((s, i) => ({ A: i + 1, B: s.site.code, AO: day('2026-02-11') })), [
        { name: 'RF & Design', headers: RF_HEADERS, rows: sites.map((s, i) => [i + 1, s.site.code, `OWN-C${i}`, 32, 30, null, null, null]) },
      ]);
      const run = await uploadMaster(t.admin.api, file);
      expect(run.status, JSON.stringify(run.body)).toBe(201);
      const queued = await t.admin.api.call('post', `/master-import/runs/${run.body.id}/apply`,
        { mode: 'submit', reason: 'Initial load', historical_load: { reason: REASON, approve_directly: true, registers: true } }, { 'If-Match': `"${run.body.version}"` });
      expect(queued.status, JSON.stringify(queued.body)).toBe(202);
      const jobId = queued.body.applying.job_id as string;
      const stored = await q<{ load_registers: boolean; parts: number }>(db,
        `SELECT load_registers, jsonb_array_length(registers -> 'parts') AS parts FROM mi_apply_jobs WHERE id = $1`, [jobId]);
      expect(stored[0]).toMatchObject({ load_registers: true, parts: 1 });
      await jobs.process((await jobs.pending(0)).find((x) => x.apply && x.job_id === jobId)!);
      const done = await t.admin.api.call('get', `/master-import/runs/${run.body.id}`);
      expect(done.body).toMatchObject({ status: 'applied', applying: { state: 'done' }, outcome: { approve_directly: true, registers: true } });
      // the parsed rows are cleared when the run ends
      expect((await q<{ r: unknown }>(db, 'SELECT registers AS r FROM mi_apply_jobs WHERE id = $1', [jobId]))[0]!.r).toBeNull();
      const rf = (done.body.outcome.batches as { id: string; ref: string; queued?: boolean }[]).find((x) => x.ref === 'rf_design')!;
      expect(rf.queued).toBe(true);
      for (const b of done.body.outcome.batches as { id: string; queued?: boolean }[]) {
        if (b.queued) await jobs.process((await jobs.pending(0)).find((x) => x.batch_id === b.id)!);
      }
      for (const s of sites) {
        expect((await records('rf_design', s.site.id))[0]).toMatchObject({ state: 'approved', flag: true, batch: rf.id });
        expect((await q<{ s: string }>(db, 'SELECT state::text AS s FROM task_instances WHERE id = $1', [s.b4]))[0]!.s).toBe('approved');
      }
      const b = await t.admin.api.call('get', `/import-batches/${rf.id}`);
      expect(b.body.status).toBe('approved');
    } finally {
      await db.query(`UPDATE settings SET value = to_jsonb(50) WHERE key = 'imports.async_rows'`);
      jobs.autoStart = true;
    }
  });

  it('refusals: registers only with the historical load of a System Admin; rows from the caller, a stranger file or the internal functions are refused', async () => {
    const t = await team();
    const a = await preCwSite('HRR');
    await openWaiver(t.admin);
    const file = await masterFile([{ A: 1, B: a.site.code, AO: day('2026-02-12') }], [
      { name: 'RF & Design', headers: RF_HEADERS, rows: [[1, a.site.code, 'OWN-R', 32, 30, null, null, null]] },
    ]);
    const run = await uploadMaster(t.admin.api, file);
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const url = `/master-import/runs/${run.body.id}/apply`;
    const im = { 'If-Match': `"${run.body.version}"` };
    // outside historical_load (strict body), and in draft mode: 422
    expect((await t.admin.api.call('post', url, { mode: 'submit', reason: 'Initial load', registers: true }, im)).status).toBe(422);
    expect((await t.admin.api.call('post', url, { mode: 'draft', reason: 'Initial load', historical_load: { reason: REASON, registers: true } }, im)).status).toBe(422);
    // the caller cannot send rows (no such field)
    expect((await t.admin.api.call('post', url, { mode: 'submit', reason: 'Initial load', historical_load: { reason: REASON, registers: true }, rows: [] }, im)).status).toBe(422);
    // a delegate of the import (not a System Admin): 403
    const dg = await makeUser(db, { assigned: true });
    await delegate(db, dg.id, [['templates', 'view'], ['templates', 'administer'], ['templates', 'import'], ['sites', 'view'], ['sites', 'edit']]);
    const dgApi = await loggedIn(app, dg);
    await dgApi.stepUp(dg.password);
    const nonAdmin = await dgApi.call('post', url, { mode: 'submit', reason: 'Initial load', historical_load: { reason: REASON, registers: true } }, im);
    expect(nonAdmin.status, JSON.stringify(nonAdmin.body)).toBe(403);
    expect((await records('rf_design', a.site.id))).toHaveLength(0);

    // the application role: the internal functions are closed, and the door refuses register rows that are not of the run's file
    const app2 = new (await import('pg')).Client({ connectionString: process.env.TEST_DATABASE_URL_HREG });
    await app2.connect();
    try {
      for (const sql of [`SELECT hda_approve_record(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), true)`,
        `SELECT hrg_stage_registers('{}'::jsonb, NULL::master_reconciliation_runs, 'submit', gen_random_uuid(), 'x')`, `SELECT hrg_row_historical()`]) {
        await expect(app2.query(sql)).rejects.toThrow(/permission denied/);
      }
      await expect(app2.query(`UPDATE register_records SET historical_direct_approved = true`)).rejects.toThrow(/permission denied/);
      await expect(app2.query(`SELECT mi_apply_run($1::uuid, NULL, 'submit', 'Initial load', true, $2::jsonb, $3::jsonb)`,
        [run.body.id, JSON.stringify({ reason: REASON, registers: true }), JSON.stringify({ file_sha256: '0'.repeat(64), parts: [] })])).rejects.toThrow();
    } finally {
      await app2.end();
    }
    // with the right person and the file: it goes through
    const ok = await t.admin.api.call('post', url, { mode: 'submit', reason: 'Initial load', historical_load: { reason: REASON, registers: true, approve_directly: true } }, im);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await records('rf_design', a.site.id))[0]).toMatchObject({ state: 'approved', flag: true });
  });
});
