import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import type { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, startApp, superDbMina } from './helpers';
import { GECOL, PROC, createRec, post, regCell, team as regTeam } from './reg-helpers';
import { day, downloadTemplate, fillTemplate, uploadFile } from './tpl-helpers';
import { SITE_ENTRY_GRANTS } from './tpl-stream-helpers';
import { Actor, Site, actor, addAssignment, makeSite, makeTask, plainAdmin, setCell } from './wf-helpers';

/**
 * Migration 0139 (owner decisions 2026-11-22), on the Master import only:
 *   1. "Pending" in a date, number or list cell is an empty cell (no error), counted in the batch notes;
 *   2. "N/A" in the task's actual date column makes the task N/A when the batch is sent (admin override by rule, kind master_na, revertible, never applied
 *      again after a revert; never a task with a human step, a date, approved, or held by a gate); N/A in any other date, number or list column is empty;
 *   3. a register row holding only its keys is a placeholder: skipped, never an error or a scope_conflict;
 *   4. a PR-PO row of scope GECOL is routed into the GECOL register;
 *   5. an empty Order Status is derived from the PO / WO date with the values of the setting (off by default);
 *   6. the one candidate with a Contract Sign-off Date is Selected = Yes unless another candidate of the site is selected; an empty Selection Date then
 *      takes the Contract Sign-off Date (owner decision 2026-11-23, Q583).
 * Manual entry keeps today's rules. Its own database (TEST_DATABASE_URL_MINA). Synthetic data only. Region 3.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 3;
const REASON = 'Historical load of the owner Master, entered as it is';

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_MINA as string });
  db = await superDbMina();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

type Cell = string | number | Date | null;
interface Sheet { name: string; headers: string[]; rows: Cell[][] }

async function masterFile(masterRows: Record<string, Cell>[], sheets: Sheet[] = [], marker = ''): Promise<Buffer> {
  const cols = await q<{ letter: string; group_top: string | null; group_mid: string | null; name: string | null }>(db, 'SELECT letter, group_top, group_mid, name FROM master_columns WHERE is_active ORDER BY ord');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Guide').getCell('A1').value = `Guide ${marker}`;
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
async function applyFile(admin: Actor, buf: Buffer, historical?: Record<string, unknown>): Promise<Record<string, any>> {
  const run = await uploadMaster(admin.api, buf);
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  const applied = await admin.api.call('post', `/master-import/runs/${run.body.id}/apply`,
    { mode: 'submit', reason: 'Load of the owner Master', ...(historical ? { historical_load: historical } : {}) }, { 'If-Match': `"${run.body.version}"` });
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  return applied.body.outcome as Record<string, any>;
}

interface TaskRow { id: string; code: string; state: string; master_na: boolean; override: boolean; na_reason: string | null }
const tasks = async (siteId: string): Promise<Record<string, TaskRow>> => Object.fromEntries((await q<TaskRow>(db,
  `SELECT t.id::text AS id, td.code, t.state::text AS state, t.master_na, t.admin_override AS override, t.na_reason
   FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id WHERE t.site_id = $1`, [siteId])).map((r) => [r.code, r]));
const overrides = (siteId: string) => q<{ id: string; task_id: string; acted_by: string | null; reverted: boolean; after: Record<string, any> }>(db,
  `SELECT id::text AS id, task_id::text AS task_id, acted_by::text AS acted_by, reverted_at IS NOT NULL AS reverted, after FROM admin_overrides
   WHERE site_id = $1 AND kind = 'master_na' ORDER BY created_at`, [siteId]);
const notesOf = async (batchId: string): Promise<Record<string, number>> => Object.fromEntries(((await q<{ n: { code: string; count: number }[] }>(db,
  'SELECT import_notes AS n FROM import_batches WHERE id = $1', [batchId]))[0]!.n).map((x) => [x.code, x.count]));
const batchRows = (batchId: string) => q<{ site_code: string; sheet: string; row_no: number; action: string; errors: { code: string }[] | null; warnings: { code: string }[] | null; payload: Record<string, any>; task_code: string | null }>(db,
  'SELECT site_code, sheet, row_no, action, errors, warnings, payload, task_code FROM import_batch_rows WHERE batch_id = $1 ORDER BY ord, row_no', [batchId]);
const codes = (l: { code: string }[] | null): string[] => (l ?? []).map((x) => x.code);

/** A site past On-Air (MS5 and MS6 approved: the gates G6 and G7 are open). */
async function onAirSite(prefix: string): Promise<Site> {
  const s = await makeSite(db, R, { prefix });
  await makeTask(db, s, 'MS5', 'approved', { actualDate: '2026-03-01' });
  await makeTask(db, s, 'MS6', 'approved', { actualDate: '2026-03-10' });
  return s;
}

describe('0139: the Master sheet reads "Pending" and "N/A" as the owner means them', () => {
  let admin: Actor;
  let s1: Site;
  let streamBatch: string;

  it('Pending and N/A are empty cells; N/A in the actual date makes the task N/A when the batch is sent (rule override, audited); never on a task with a human step or held by a gate', async () => {
    admin = await plainAdmin(app, db);
    s1 = await onAirSite('MNA');
    await makeTask(db, s1, 'D8', 'locked');
    await makeTask(db, s1, 'D11', 'open');
    const s2 = await onAirSite('MNB');
    const d11b = await makeTask(db, s2, 'D11', 'open');
    await db.query(`INSERT INTO workflow_steps (task_id, level, action, acted_by, note, before_state, after_state, created_at)
                    VALUES ($1, 1, 'reassign', $2, 'reassigned by the lead', 'open', 'open', clock_timestamp())`, [d11b, admin.user.id]);
    const s3 = await makeSite(db, R, { prefix: 'MNC' });   // MS5 not approved: the gate G6 holds D8
    await makeTask(db, s3, 'MS5', 'locked');
    await makeTask(db, s3, 'D8', 'locked');

    const out = await applyFile(admin, await masterFile([
      // s1: D11 SSV date N/A, D8 MW alignment date n/a and RSL N/A, D9 integration Pending, D10 window and cutover N/A, CW PAC N/A (no B13 task on the site)
      { A: 1, B: s1.code, DR: 'N/A', CX: 'n/a', CY: 'N/A', DA: 'Pending', DD: 'N/A', DE: ' na ', DF: 'N/A', BV: 'N/A', BR: 'Not applicable' },
      { A: 2, B: s2.code, DR: 'N/A' },
      { A: 3, B: s3.code, CX: 'N/A' },
    ]));
    const stream = (out.batches as { id: string; kind: string; ref: string; errors: number; import_notes?: { code: string; count: number }[] }[]).filter((b) => b.kind === 'stream');
    expect(stream.length).toBeGreaterThan(0);
    // no invalid_date / invalid_number / not_in_list anywhere
    for (const b of stream) {
      for (const r of await batchRows(b.id)) {
        expect(codes(r.errors), JSON.stringify(r)).not.toEqual(expect.arrayContaining(['invalid_date']));
        expect(codes(r.errors)).not.toContain('invalid_number');
        expect(codes(r.errors)).not.toContain('not_in_list');
      }
    }
    const te = stream.find((b) => b.ref === 'installation' || (b.import_notes ?? []).some((n) => n.code === 'na_task_requested'))!;
    streamBatch = te.id;
    const notes = await notesOf(te.id);
    expect(notes).toMatchObject({ pending_as_empty: 1, na_task_requested: 2, na_task_not_applicable: 2, na_task_marked: 2 });
    expect(notes.na_as_empty).toBeGreaterThanOrEqual(4);   // RSL, window start, window end, cutover result (+ the CW PAC cells in their own stream)

    // s1: D11 and D8 are N/A by the rule (admin override, no acting person), audited, with the batch row
    const t1 = await tasks(s1.id);
    expect(t1.D11).toMatchObject({ state: 'na', master_na: true, override: true, na_reason: 'N/A in the Master file' });
    expect(t1.D8).toMatchObject({ state: 'na', master_na: true, override: true });
    const o1 = await overrides(s1.id);
    expect(o1).toHaveLength(2);
    expect(o1[0]).toMatchObject({ acted_by: null, reverted: false, after: { state: 'na', batch_id: te.id } });
    const au = await q<{ actor_id: string | null; is_admin_override: boolean; after: Record<string, any> }>(db,
      `SELECT actor_id::text AS actor_id, is_admin_override, after FROM audit_log WHERE action = 'task_master_na' AND site_id = $1 ORDER BY id`, [s1.id]);
    expect(au).toHaveLength(2);
    expect(au[0]).toMatchObject({ actor_id: null, is_admin_override: true, after: { master_na: true, batch_id: te.id, uploaded_by: admin.user.id } });
    const rows = await batchRows(te.id);
    expect(codes(rows.find((r) => r.site_code === s1.code && r.task_code === 'D11')!.warnings)).toEqual(['master_na_requested', 'master_na_marked']);
    // s2: a person acted on D11 (reassigned): not made N/A
    expect((await tasks(s2.id)).D11).toMatchObject({ state: 'open', master_na: false });
    expect(codes(rows.find((r) => r.site_code === s2.code)!.warnings)).toEqual(['master_na_not_applicable']);
    // s3: the gate G6 holds D8: not made N/A
    expect((await tasks(s3.id)).D8).toMatchObject({ state: 'locked', master_na: false });
    expect(await overrides(s3.id)).toHaveLength(0);
    // the task DTO lists the override as revertible
    const td = await admin.api.call('get', `/tasks/${t1.D11!.id}`);
    expect(td.status, JSON.stringify(td.body)).toBe(200);
    expect(td.body.overrides).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'master_na', revertible: true })]));
  });

  it('the N/A is reverted through POST /overrides/{id}/revert and is never applied again by a later Master file', async () => {
    const d11 = (await tasks(s1.id)).D11!;
    const o = (await overrides(s1.id)).find((x) => x.task_id === d11.id)!;
    const noStep = await plainAdmin(app, db, false);
    expect((await noStep.api.call('post', `/overrides/${o.id}/revert`, { reason: 'No step-up' })).status).toBe(401);
    const rv = await admin.api.call('post', `/overrides/${o.id}/revert`, { reason: 'The SSV was done after all' });
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);
    expect(rv.body).toMatchObject({ kind: 'master_na', revertible: false });
    expect((await tasks(s1.id)).D11).toMatchObject({ state: 'open', master_na: false, override: false, na_reason: null });
    expect((await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'task_master_na_restore' AND site_id = $1`, [s1.id]))[0]!.n).toBe(1);

    // the same N/A again in a later file: not made N/A (a System Admin restored it)
    const out = await applyFile(admin, await masterFile([{ A: 1, B: s1.code, DR: 'N/A' }], [], 'second'));
    const b = (out.batches as { id: string; kind: string }[]).filter((x) => x.kind === 'stream');
    const all = (await Promise.all(b.map((x) => batchRows(x.id)))).flat();
    expect(codes(all.find((r) => r.site_code === s1.code && r.task_code === 'D11')!.warnings)).toEqual(['master_na_not_applicable']);
    expect((await tasks(s1.id)).D11).toMatchObject({ state: 'open', master_na: false });
    expect((await overrides(s1.id)).filter((x) => x.task_id === d11.id)).toHaveLength(1);
    expect(streamBatch).toBeTruthy();
  });

  it('the application role cannot call the internals, write the flag, the notes or the rule setting', async () => {
    const app2 = new (await import('pg')).Client({ connectionString: process.env.TEST_DATABASE_URL_MINA });
    await app2.connect();
    try {
      for (const sql of [`SELECT mina_mark_task(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x')`, `SELECT mina_apply_batch(gen_random_uuid())`,
        `SELECT mina_restore_task(gen_random_uuid(), gen_random_uuid(), 'x', 'x', true)`, `SELECT mina_prep_register_unit('{}'::jsonb)`,
        `SELECT mina_route_regs('{}'::jsonb)`, `SELECT mina_notes_add(gen_random_uuid(), '{}'::jsonb)`, `SELECT imp_master_unit_pre_0139('{}'::jsonb, 'x', 'x', 'submit', 'x', NULL, NULL, NULL)`]) {
        await expect(app2.query(sql)).rejects.toThrow(/permission denied/);
      }
      await expect(app2.query(`UPDATE task_instances SET master_na = true, master_na_at = now()`)).rejects.toThrow(/permission denied/);
      await expect(app2.query(`UPDATE import_batches SET import_notes = '[]'`)).rejects.toThrow(/permission denied/);
    } finally {
      await app2.end();
    }
    // the definer without its marker row is refused by the guard
    const d8 = (await tasks(s1.id)).D11!.id;
    await db.query('BEGIN');
    try {
      await db.query(`SELECT set_config('pmis.mina_task', $1, true)`, [d8]);
      await db.query('SET LOCAL ROLE pmis_definer');
      await expect(db.query(`UPDATE task_instances SET state = 'na', is_na = true, master_na = true, master_na_at = now() WHERE id = $1`, [d8]))
        .rejects.toThrow(/written only by GSDN Workspace/);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});

describe('0139 (security review): the N/A of the Master file needs the rights of an entry of the task, at the staging and at the send (TPL-MASTER upload)', () => {
  const SSV = 'SSV / SSV Date';
  const OTHER = 2;
  async function upload(a: Actor, siteCode: string): Promise<{ id: string; version: number }> {
    const dl = await downloadTemplate(a.api, 'TPL-MASTER');
    expect(dl.status).toBe(200);
    const file = await fillTemplate(dl.buffer, [{ 'Site ID': siteCode, [SSV]: 'N/A' }], { sheet: 'Master' });
    const res = await uploadFile(a.api, file);
    expect([201, 202], JSON.stringify(res.body)).toContain(res.status);
    const parts = (res.body.parts ?? [res.body]) as { id: string; version: number; stream?: string }[];
    const te = parts.find((x) => x.stream === 'TE')!;
    expect(te, JSON.stringify(res.body)).toBeTruthy();
    return { id: te.id, version: te.version };
  }
  const send = async (a: Actor, b: { id: string; version: number }) => {
    const r = await a.api.call('post', `/import-batches/${b.id}/submit`, undefined, { 'If-Match': `"${b.version}"` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const d11Row = async (batchId: string) => (await batchRows(batchId)).find((r) => r.task_code === 'D11')!;
  const entryUser = (regions: number[]) => actor(app, db, { level: 'entry', grants: SITE_ENTRY_GRANTS, regions, modules: null });

  it('a region-limited importer (sites view in the task region, import and edit elsewhere) cannot make the task N/A', async () => {
    const s = await onAirSite('MSR');
    const d11 = await makeTask(db, s, 'D11', 'open');
    const u = await entryUser([OTHER]);
    await addAssignment(db, u.user.id, { level: 'view', regions: [R], modules: null, grants: [['sites', 'view'], ['templates', 'view']] });
    await setCell(db, 'D11', R, 'entry', { user: [u.user.id] });
    const b = await upload(u, s.code);
    const row = await d11Row(b.id);
    expect(codes(row.warnings)).toEqual(['master_na_not_applicable']);
    expect(row.payload.master_na).toBeUndefined();
    await send(u, b);
    expect((await tasks(s.id)).D11).toMatchObject({ state: 'open', master_na: false });
    expect(await overrides(s.id)).toHaveLength(0);
    expect(d11).toBeTruthy();
  });

  it('a user who is not an entry holder (L1) of the task cannot make it N/A', async () => {
    const s = await onAirSite('MSE');
    await makeTask(db, s, 'D11', 'open');
    const holder = await entryUser([R]);
    const u = await entryUser([R]);
    await setCell(db, 'D11', R, 'entry', { user: [holder.user.id] });
    const b = await upload(u, s.code);
    expect(codes((await d11Row(b.id)).warnings)).toEqual(['master_na_not_applicable']);
    await send(u, b);
    expect((await tasks(s.id)).D11).toMatchObject({ state: 'open', master_na: false });
  });

  it('the entry holder makes it N/A when the batch is sent; rights revoked between the staging and the send: not applied', async () => {
    const s = await onAirSite('MSK');
    await makeTask(db, s, 'D11', 'open');
    const u = await entryUser([R]);
    await setCell(db, 'D11', R, 'entry', { user: [u.user.id] });
    const ok = await upload(u, s.code);
    expect(codes((await d11Row(ok.id)).warnings)).toEqual(['master_na_requested']);
    await send(u, ok);
    expect((await tasks(s.id)).D11).toMatchObject({ state: 'na', master_na: true });

    const s2 = await onAirSite('MSK');
    await makeTask(db, s2, 'D11', 'open');
    const b = await upload(u, s2.code);
    expect(codes((await d11Row(b.id)).warnings)).toEqual(['master_na_requested']);
    const other = await entryUser([R]);
    await setCell(db, 'D11', R, 'entry', { user: [other.user.id] });   // the Matrix moved L1 to someone else before the send
    await send(u, b);
    expect((await tasks(s2.id)).D11).toMatchObject({ state: 'open', master_na: false });
    const row = await d11Row(b.id);
    expect(codes(row.warnings)).toEqual(['master_na_requested', 'master_na_not_marked']);
    expect(row.payload).toMatchObject({ master_na_result: 'skipped', master_na_reason: 'not_entry_holder' });
    expect(await notesOf(b.id)).toMatchObject({ na_task_not_marked: 1 });
  });
});

describe('0139: the register sheets of the Master import', () => {
  it('placeholders skipped, GECOL requests of PR-PO routed to GECOL, Order Status derived, the one candidate with a sign-off selected; another selected candidate keeps the error', async () => {
    const admin = await plainAdmin(app, db);
    for (const k of ['gecol', 'procurement', 'acquisition', 'hlc']) await regCell(db, k, R, 'entry', { user: [admin.user.id] });
    const r = await admin.api.call('put', '/settings/historical-waiver', { open: true, cutoff_date: '2026-06-30', reason: 'Open for the historical load' });
    expect([200, 409]).toContain(r.status);
    // rule 5 as seeded (owner decision 2026-11-23, Q582): Active, Completed only with a delivery / completion field, which PR-PO does not have
    expect((await q<{ value: unknown }>(db, `SELECT value FROM settings WHERE key = 'imports.master_order_status_derived'`))[0]!.value)
      .toEqual({ open: 'Active', completed: 'Completed', completion_field: null });
    const g1 = await makeSite(db, R, { prefix: 'MRG' });
    const g2 = await makeSite(db, R, { prefix: 'MRG' });
    const g3 = await makeSite(db, R, { prefix: 'MRG' });
    const p1 = await makeSite(db, R, { prefix: 'MRP' });
    const a1 = await makeSite(db, R, { prefix: 'MRA' });
    const a2 = await makeSite(db, R, { prefix: 'MRA' });
    await db.query(`UPDATE sites SET scope_gecol_power = 'yes', scope_hlc_fiber = 'yes' WHERE id = ANY($1::uuid[])`, [[g1.id, g3.id, p1.id]]);
    await db.query(`UPDATE sites SET scope_gecol_power = 'na', scope_hlc_fiber = 'na' WHERE id = $1`, [g2.id]);

    const out = await applyFile(admin, await masterFile([{ A: 1, B: g1.code }], [
      { name: 'GECOL', headers: ['#', 'Site ID', 'GECOL PR No.', 'Survey Date'], rows: [[1, g1.code, null, null], [2, g2.code, null, 'N/A']] },
      { name: 'HLC', headers: ['#', 'Site ID', 'Request Date'], rows: [[1, g1.code, null], [2, g2.code, 'Pending']] },
      { name: 'PR-PO', headers: ['#', 'Site ID', 'Scope', 'PR No.', 'PR Date', 'PO / WO No.', 'PO / WO Date', 'Order Status', 'Remark'], rows: [
        [1, p1.code, 'CW', 'PR-71', day('2026-01-05'), null, null, null, null],                         // no PO: Active
        [2, p1.code, 'Tower Erection', 'PR-72', day('2026-01-05'), 'PO-72', day('2026-01-20'), 'Pending', null],   // PO issued, not delivered: Active
        [3, g1.code, 'GECOL', 'GP-11', day('2026-01-07'), 'PO-G1', null, null, 'merged'],               // into the GECOL placeholder of g1
        [4, g3.code, 'GECOL', 'GP-33', day('2026-01-08'), null, null, null, null],                      // a GECOL row of its own
      ] },
      { name: 'Acquisition', headers: ['#', 'Site ID', 'Candidate', 'Selected', 'Contract Sign-off Date', 'Title Verified'], rows: [
        [1, a1.code, 'A', 'No', day('2026-02-01'), 'N/A'],
        [2, a2.code, 'A', 'Yes', null, null],
        [3, a2.code, 'B', 'No', day('2026-02-02'), null],
      ] },
    ]), { reason: REASON, registers: true });
    const batches = out.batches as { id: string; kind: string; ref: string; sheet: string; import_notes?: { code: string; count: number }[] }[];
    const gec = batches.find((b) => b.ref === 'gecol')!;
    const proc = batches.find((b) => b.ref === 'procurement')!;
    const acq = batches.find((b) => b.ref === 'acquisition')!;
    // HLC: placeholders only, skipped with the count (never an error, never a scope_conflict)
    expect(batches.find((b) => b.ref === 'hlc')).toBeUndefined();
    const hlc = (out.skipped as { ref: string; reason: string; detail: string }[]).find((s) => s.ref === 'hlc')!;
    expect(hlc).toMatchObject({ reason: 'no_rows' });
    expect(hlc.detail).toContain('2 placeholder row(s)');

    // GECOL: g2 placeholder skipped, g1 placeholder merged with its PR-PO request, g3 routed as its own row
    expect(await notesOf(gec.id)).toMatchObject({ placeholder_rows_skipped: 1, routed_from_procurement: 2 });
    const gr = await batchRows(gec.id);
    expect(gr).toHaveLength(2);
    for (const x of gr) expect(codes(x.errors), JSON.stringify(x)).toEqual([]);
    expect(gr.find((x) => x.site_code === g3.code)).toMatchObject({ sheet: 'PR-PO', row_no: 6 });
    expect(codes(gr.find((x) => x.site_code === g1.code)!.warnings)).toContain('routed_from_procurement');
    const rec = async (key: string, siteId: string) => q<{ data: Record<string, any>; state: string }>(db,
      `SELECT DISTINCT ON (entity_id) data, state FROM register_records WHERE register_key = $1 AND site_id = $2 ORDER BY entity_id, version_no DESC`, [key, siteId]);
    expect((await rec('gecol', g1.id))[0]).toMatchObject({ state: expect.stringMatching(/^in_(review|approval)$/), data: { pr_no: 'GP-11', request_date: '2026-01-07', remark: 'merged' } });
    expect((await rec('gecol', g3.id))[0]).toMatchObject({ state: expect.stringMatching(/^in_(review|approval)$/), data: { pr_no: 'GP-33', request_date: '2026-01-08' } });
    expect(await rec('gecol', g2.id)).toHaveLength(0);
    expect(await rec('procurement', g1.id)).toHaveLength(0);

    // PR-PO: no wrong_register, Order Status derived and flagged
    expect(await notesOf(proc.id)).toMatchObject({ routed_to_gecol: 2, order_status_derived: 2, pending_as_empty: 1 });
    const pr = await batchRows(proc.id);
    expect(pr).toHaveLength(2);
    for (const x of pr) {
      expect(codes(x.errors), JSON.stringify(x)).toEqual([]);
      expect(codes(x.warnings)).toContain('order_status_derived');
    }
    const procRecs = await q<{ data: Record<string, any> }>(db, `SELECT data FROM register_records WHERE register_key = 'procurement' AND site_id = $1 ORDER BY data ->> 'pr_no'`, [p1.id]);
    expect(procRecs.map((x) => x.data.order_status)).toEqual(['Active', 'Active']);

    // Acquisition: a1 selected by the import, its empty Selection Date taken from the Contract Sign-off Date (Q583); a2 B keeps not_selected
    expect(await notesOf(acq.id)).toMatchObject({ selected_set_by_import: 1, selection_date_from_contract: 1, selected_not_set: 1, na_as_empty: 1 });
    const ar = await batchRows(acq.id);
    const ra1 = ar.find((x) => x.site_code === a1.code)!;
    expect(codes(ra1.warnings)).toContain('selected_set_by_import');
    expect(codes(ra1.errors)).not.toContain('not_selected');
    expect(ra1.payload.data).toMatchObject({ selected: 'Yes', selection_date: '2026-02-01' });
    expect(codes(ra1.warnings)).toContain('selection_date_from_contract');
    expect(JSON.stringify(ra1.errors)).not.toContain('selection_date');
    expect(ra1.payload.data.title_verified).toBeUndefined();
    const ra2 = ar.find((x) => x.site_code === a2.code && x.row_no === 5)!;
    expect(codes(ra2.errors)).toContain('not_selected');
    const au = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'import_batch.master_import_rules' AND entity_id = ANY($1::text[])`,
      [[gec.id, proc.id, acq.id]]);
    expect(au[0]!.n).toBe(3);
  });

  it('manual entry keeps today\'s rules: a GECOL record of keys only is refused, a Procurement request of scope GECOL is refused (wrong_register)', async () => {
    const g = await regTeam(app, db, 'gecol', 'gecol', R);
    const blank = await createRec(g, {});
    const sub = await post(g.entry.api, 'gecol', blank.id, 'submit', blank.version);
    expect(sub.status).toBe(422);
    expect(JSON.stringify(sub.body)).toContain('required');
    expect(GECOL.pr_no).toBeTruthy();
    const p = await regTeam(app, db, 'procurement', 'procurement', R);
    const res = await p.entry.api.call('post', '/registers/procurement/records', { site_id: p.site.id, data: { ...PROC, scope: 'GECOL' } });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('wrong_register');
  });
});
