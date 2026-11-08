import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { getBinary, load, TPL_GRANTS_ENTRY } from './tpl-helpers';
import { taskRow } from './tpl-stream-helpers';
import { Site, actor, makeSite, makeTask, plainAdmin } from './wf-helpers';

/**
 * Migration 0060 (work package P3): the admin-only legacy import of the real Master (Q1), the comparison report of the parallel run (Q211), the role and
 * region aliases (Q8, Q10) and the Issue Log projection of GA:GE (Q11). The Master files are built in the test, with the three header rows of the real Master.
 * Region 3 (WM): no other suite sets matrix cells there, so a System Admin is the entry holder of last resort (no holder) and no other L1 exists.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 3;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

interface MasterCol { ord: number; letter: string; group_top: string | null; group_mid: string | null; name: string | null }
let colsCache: MasterCol[] | null = null;
async function masterCols(): Promise<MasterCol[]> {
  colsCache ??= await q<MasterCol>(db, 'SELECT ord, letter, group_top, group_mid, name FROM master_columns WHERE is_active ORDER BY ord');
  return colsCache;
}

type Cell = string | number | Date | { formula: string; result: unknown };
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

/** A Master workbook as the owner keeps it: three header rows, a SUBTOTAL row, data rows from row 5, the Setting sheet with Project Staff. No _tpl. */
async function masterFile(rows: Record<string, Cell>[], o: { staff?: [string, string, string][]; dropHeader?: string; rename?: Record<string, string>; sheets?: string[]; noMaster?: boolean; tpl?: boolean } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Guide').getCell('A1').value = 'Guide';
  if (!o.noMaster) {
    const ws = wb.addWorksheet('Master');
    for (const c of await masterCols()) {
      if (c.letter === o.dropHeader) continue;
      ws.getCell(`${c.letter}1`).value = c.group_top ?? null;
      ws.getCell(`${c.letter}2`).value = c.group_mid ?? null;
      ws.getCell(`${c.letter}3`).value = o.rename?.[c.letter] ?? c.name ?? null;
      ws.getCell(`${c.letter}4`).value = { formula: `SUBTOTAL(3,${c.letter}5:${c.letter}504)`, result: 0 };
    }
    rows.forEach((r, i) => {
      for (const [L, v] of Object.entries(r)) {
        const cell = ws.getCell(`${L}${5 + i}`);
        cell.value = v as ExcelJS.CellValue;
        if (v instanceof Date || (typeof v === 'object' && (v as { result?: unknown }).result instanceof Date)) cell.numFmt = 'yyyy-mm-dd';
      }
    });
  }
  const st = wb.addWorksheet('Setting');
  st.getCell('I1').value = 'Project Staff';
  ['Name', 'Role', 'Region', 'Status'].forEach((h, i) => { st.getCell(2, 9 + i).value = h; });
  (o.staff ?? []).forEach(([n, r, g], i) => { st.getCell(3 + i, 9).value = n; st.getCell(3 + i, 10).value = r; st.getCell(3 + i, 11).value = g; st.getCell(3 + i, 12).value = 'Active'; });
  for (const s of o.sheets ?? ['RF & Design', 'Acquisition']) wb.addWorksheet(s);
  if (o.tpl) wb.addWorksheet('_tpl').getCell('A1').value = 'template_id';
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** mx_issue_cells answers only for a site the session may see: read it as a session that sees every region. */
async function issueCells(siteId: string): Promise<Record<string, unknown>> {
  await db.query('BEGIN');
  try {
    await db.query(`SET LOCAL app.region_ids = '*'`);
    return (await q<{ c: Record<string, unknown> }>(db, 'SELECT mx_issue_cells($1) AS c', [siteId]))[0]!.c;
  } finally {
    await db.query('COMMIT');
  }
}

function uploadMaster(api: Api, buf: Buffer, name = 'GSDN_Site_Master.xlsx'): request.Test {
  const t = api.raw('post', '/master-import/runs');
  if (api.csrf) t.set('X-CSRF-Token', api.csrf);
  return t.attach('file', buf, { filename: name, contentType: 'application/octet-stream' });
}
const diffsOf = async (api: Api, id: string, query = ''): Promise<Record<string, any>[]> => {
  const r = await api.call('get', `/master-import/runs/${id}/diffs?limit=200${query}`);
  expect(r.status).toBe(200);
  return r.body.items;
};
const logRows = (reason: string): Promise<{ context: Record<string, unknown>; user_id: string }[]> =>
  q(db, `SELECT context, user_id FROM system_log WHERE source = 'master-import' AND context ->> 'reason' = $1 ORDER BY id DESC LIMIT 3`, [reason]);

interface Fixture { site: Site; other: Site; b4: string; ms1: string }
async function fixture(): Promise<Fixture> {
  const site = await makeSite(db, R, { prefix: 'MI' });
  const other = await makeSite(db, R, { prefix: 'MI' });
  const b4 = await makeTask(db, site, 'B4', 'open');
  const ms1 = await makeTask(db, site, 'MS1', 'approved', { actualDate: '2026-01-02' });
  await makeTask(db, other, 'B4', 'open');
  return { site, other, b4, ms1 };
}

describe('legacy Master import: identification, preview and the comparison report (Q1, Q211)', () => {
  it('identifies the file by its sheets and headers, compares every cell with GSDN Workspace, writes nothing, keeps the original and logs the use', async () => {
    const admin = await plainAdmin(app, db);
    const f = await fixture();
    const buf = await masterFile([
      { A: 1, B: f.site.code, E: 'WM Area', AM: 'Eng Legacy', AO: day('2026-02-03'), V: { formula: 'MAX(U5)', result: day('2026-01-05') } },
      { A: 2, B: f.other.code, E: 'Nowhere Area' },
      { A: 3, B: 'NOT-A-SITE-XYZ', AO: day('2026-02-04') },
    ], { staff: [['Ahmed Test', 'Team Lead (CW)', 'Tripoli Area'], ['Sara Test', 'Site Engineer', 'Mars Area']] });
    const res = await uploadMaster(admin.api, buf);
    expect(res.status).toBe(201);
    const run = res.body;
    expect(run).toMatchObject({ status: 'previewed', file_sha256: sha(buf), file_size: buf.length, has_file: true, file_name: 'GSDN_Site_Master.xlsx' });
    expect(run.structure).toMatchObject({ identified: true, columns_expected: 187, columns_found: 187, has_tpl: false });
    expect(run.structure.register_sheets_missing).toContain('GECOL');
    expect(run.summary).toMatchObject({ rows: 3, sites_matched: 2, sites_unknown: 1 });

    const d = await diffsOf(admin.api, run.id);
    const one = (col: string, code = f.site.code) => d.find((x) => x.master_col === col && x.site_code === code);
    // a typed task column that differs: applicable through the batch flow
    expect(one('AO')).toMatchObject({ kind: 'diff', reason: 'value_differs', applicable: true, master_value: '2026-02-03', pmis_value: null, source_ref: 'Master!5', field: 'B4:actual_date' });
    expect(one('AM')).toMatchObject({ kind: 'diff', reason: 'value_differs', master_value: 'Eng Legacy' });
    // a calculated column is compared with the cached Master value, never applied
    expect(one('V')).toMatchObject({ kind: 'diff', reason: 'calculated', applicable: false, master_value: '2026-01-05', pmis_value: '2026-01-02' });
    // the region goes through the alias table (Q10): "WM Area" is the site's region; an unknown value is an exception
    expect(one('E')).toBeUndefined();
    expect(one('E', f.other.code)).toMatchObject({ kind: 'exception', reason: 'region_alias_unknown', master_value: 'Nowhere Area' });
    expect(d.find((x) => x.site_code === 'NOT-A-SITE-XYZ')).toMatchObject({ kind: 'missing_in_pmis', reason: 'site_not_in_pmis', source_ref: 'Master!7' });
    // Q8: the staff roles are mapped through the alias table; nothing is mapped yet (owner data), the generic Site Engineer is ambiguous
    expect(d.filter((x) => x.sheet === 'Setting').map((x) => [x.reason, x.master_value])).toEqual(expect.arrayContaining([
      ['role_unmapped', 'Team Lead (CW)'], ['role_ambiguous', 'Site Engineer'], ['region_alias_unknown', 'Mars Area']]));
    // filters
    expect((await diffsOf(admin.api, run.id, '&kind=exception')).every((x) => x.kind === 'exception')).toBe(true);
    expect((await diffsOf(admin.api, run.id, `&site_code=${f.other.code}`)).every((x) => x.site_code === f.other.code)).toBe(true);

    // nothing changed in GSDN Workspace
    expect(await taskRow(db, f.b4)).toMatchObject({ state: 'open', actual_date: null });
    // the use is audited and in the System Log; the original is kept as uploaded
    const au = await q<{ after: Record<string, any> }>(db, `SELECT after FROM audit_log WHERE action = 'master_import.preview' AND entity_id = $1`, [run.id]);
    expect(au[0]!.after).toMatchObject({ file_sha256: sha(buf), file_name: 'GSDN_Site_Master.xlsx' });
    const sl = await q<{ context: Record<string, unknown> }>(db, `SELECT context FROM system_log WHERE source = 'master-import' AND context ->> 'run_id' = $1`, [run.id]);
    expect(sl).toHaveLength(1);
    const file = await getBinary(admin.api, `/master-import/runs/${run.id}/file`);
    expect(file.status).toBe(200);
    expect(sha(file.buffer)).toBe(sha(buf));
    expect((await q(db, `SELECT 1 FROM audit_log WHERE action = 'master_import.file_download' AND entity_id = $1`, [run.id]))).toHaveLength(1);
    // the runs are listed (repeated reconciliation runs of the parallel month)
    const list = await admin.api.call('get', '/master-import/runs');
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(run.id);
  });

  it('exports the comparison report as XLSX and records the resolution of a difference with its note (audited)', async () => {
    const admin = await plainAdmin(app, db);
    const f = await fixture();
    const run = (await uploadMaster(admin.api, await masterFile([{ A: 1, B: f.site.code, AO: day('2026-02-03') }]))).body;
    const diff = (await diffsOf(admin.api, run.id)).find((x) => x.master_col === 'AO')!;
    expect((await admin.api.call('patch', `/master-import/diffs/${diff.id}`, { resolution: 'ignored' })).status).toBe(422);   // a note is required
    const ok = await admin.api.call('patch', `/master-import/diffs/${diff.id}`, { resolution: 'master_correct', note: 'The Master has the right date.' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ resolution: 'master_correct', resolution_note: 'The Master has the right date.', resolved_by: { id: admin.user.id } });
    const au = await q<{ before: Record<string, unknown>; after: Record<string, unknown> }>(db, `SELECT before, after FROM audit_log WHERE action = 'master_import.diff_resolve' AND entity_id = $1`, [diff.id]);
    expect(au[0]).toMatchObject({ before: { resolution: 'open' }, after: { resolution: 'master_correct' } });

    const x = await getBinary(admin.api, `/master-import/runs/${run.id}/export`);
    expect(x.status).toBe(200);
    expect(x.headers['content-disposition']).toMatch(/^attachment; filename="master-comparison_/);
    const wb = await load(x.buffer);
    const ws = wb.getWorksheet('Differences')!;
    const head = (ws.getRow(1).values as unknown[]).slice(1);
    expect(head).toEqual(['Site ID', 'Region', 'Source (Sheet!row)', 'Master column', 'Field', 'PMIS field', 'Master value', 'PMIS value', 'Kind', 'Reason', 'Applicable',
      'Resolution', 'Resolution note', 'Resolved by', 'Resolved at']);
    const txt = (v: unknown): string => (v && typeof v === 'object' && 'richText' in (v as object) ? (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('') : String(v ?? ''));
    let found = false;
    ws.eachRow((r, n) => { if (n > 1 && txt(r.getCell(4).value) === 'AO' && txt(r.getCell(1).value) === f.site.code) { found = true; expect(txt(r.getCell(12).value)).toBe('master_correct'); } });
    expect(found).toBe(true);
    expect(txt(wb.getWorksheet('Run')!.getRow(3).getCell(2).value)).toBe(run.file_sha256);
    expect((await q(db, `SELECT 1 FROM audit_log WHERE action = 'master_import.export' AND entity_id = $1`, [run.id]))).toHaveLength(1);
  });

  it('identifies the real Site Master of the repository (no _tpl, Excel tables, formula rows): every one of the 187 headers is found', async () => {
    const admin = await plainAdmin(app, db);
    const real = readFileSync(join(__dirname, '..', '..', '..', '..', 'GSDN_Site_Master.xlsx'));
    const res = await uploadMaster(admin.api, real);
    expect(res.status).toBe(201);
    expect(res.body.structure).toMatchObject({ identified: true, columns_found: 187, missing: [], moved: [] });
    expect(res.body.summary).toMatchObject({ rows: 0 });       // the shipped Master holds no site yet
  }, 120000);
});

describe('legacy Master import: apply through the batch flow', () => {
  it('needs a reason and a step-up, enters the typed task columns through TPL-MASTER staging and sends them for L2, and never applies the same file twice', async () => {
    const admin = await plainAdmin(app, db, false);
    const f = await fixture();
    const buf = await masterFile([{ A: 1, B: f.site.code, AO: day('2026-02-03'), AN: day('2026-02-01') }]);
    const run = (await uploadMaster(admin.api, buf)).body;
    const ifm = { 'If-Match': `"${run.version}"` };
    expect((await admin.api.call('post', `/master-import/runs/${run.id}/apply`, { mode: 'submit' }, ifm)).status).toBe(422);     // reason
    const noStep = await admin.api.call('post', `/master-import/runs/${run.id}/apply`, { mode: 'submit', reason: 'Initial load of the Master' }, ifm);
    expect(noStep.status).toBe(401);
    expect(noStep.body).toMatchObject({ code: 'step_up_required' });
    expect((await taskRow(db, f.b4)).state).toBe('open');
    expect((await admin.api.stepUp(admin.user.password)).status).toBe(200);
    const ok = await admin.api.call('post', `/master-import/runs/${run.id}/apply`, { mode: 'submit', reason: 'Initial load of the Master' }, ifm);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'applied', apply_mode: 'submit', apply_reason: 'Initial load of the Master' });
    const b = ok.body.outcome.batches as { id: string; ref: string; submitted: number }[];
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ ref: 'CW', submitted: 1 });
    const batch = await q<{ source: string; group_id: string; stream_code: string }>(db, 'SELECT source, group_id::text, stream_code FROM import_batches WHERE id = $1', [b[0]!.id]);
    expect(batch[0]).toMatchObject({ source: 'master_import', group_id: ok.body.group_id, stream_code: 'CW' });
    const t = await taskRow(db, f.b4);
    expect(t).toMatchObject({ actual_date: '2026-02-03', planned_date: '2026-02-01', actual_start: '2026-02-03' });    // B4 is single-event: its date is its start (Q209)
    expect(['in_review', 'in_approval']).toContain(t.state);                                                             // L2 decides next
    const rows = await q<{ source_ref: string }>(db, 'SELECT source_ref FROM import_batch_rows WHERE batch_id = $1', [b[0]!.id]);
    expect(rows[0]!.source_ref).toBe('Master!5');
    expect((await q(db, `SELECT 1 FROM audit_log WHERE action = 'master_import.apply' AND entity_id = $1 AND reason = 'Initial load of the Master'`, [run.id]))).toHaveLength(1);

    // the run is applied once; the same file can be compared again, never applied again
    expect((await admin.api.call('post', `/master-import/runs/${run.id}/apply`, { mode: 'submit', reason: 'again' }, { 'If-Match': `"${ok.body.version}"` })).status).toBe(409);
    const again = (await uploadMaster(admin.api, buf)).body;
    expect(again.status).toBe('previewed');
    const twice = await admin.api.call('post', `/master-import/runs/${again.id}/apply`, { mode: 'submit', reason: 'again' }, { 'If-Match': `"${again.version}"` });
    expect(twice.status).toBe(409);
    expect(twice.body.detail).toContain('already applied');
  });

  it('applies in Save Draft / Planning mode: the plan is saved, the pending task is not started and nothing is submitted (Q206, Q209)', async () => {
    const admin = await plainAdmin(app, db);
    const f = await fixture();
    const run = (await uploadMaster(admin.api, await masterFile([{ A: 1, B: f.site.code, AN: day('2026-03-01') }]))).body;
    const ok = await admin.api.call('post', `/master-import/runs/${run.id}/apply`, { mode: 'draft', reason: 'Plan dates of the Master' }, { 'If-Match': `"${run.version}"` });
    expect(ok.status).toBe(200);
    expect(ok.body.outcome.batches[0]).toMatchObject({ saved: 1, submitted: 0 });
    expect(await taskRow(db, f.b4)).toMatchObject({ state: 'open', planned_date: '2026-03-01', actual_start: null });
    const st = await q<{ status: string; mode: string }>(db, 'SELECT status, mode FROM import_batches WHERE id = $1', [ok.body.outcome.batches[0].id]);
    expect(st[0]).toEqual({ status: 'applied', mode: 'draft' });
  });
});

describe('legacy Master import: refusals', () => {
  it('is for a System Admin (or a delegate of templates administer) only, keeps the package guard, and refuses a file that is not the Master, with a System Log row', async () => {
    const admin = await plainAdmin(app, db);
    const importer = await actor(app, db, { grants: [...TPL_GRANTS_ENTRY, ...G('sites', 'view', 'edit')], regions: null, modules: null });
    const good = await masterFile([{ A: 1, B: 'X-1' }]);
    const forbidden = await uploadMaster(importer.api, good);
    expect(forbidden.status).toBe(403);
    expect((await importer.api.call('get', '/master-import/runs')).status).toBe(403);
    // a delegate of templates administer may use it
    const deleg = await actor(app, db, { grants: [...G('templates', 'view', 'administer')], regions: null, modules: null });
    expect((await deleg.api.call('get', '/master-import/runs')).status).toBe(200);

    const macro = await uploadMaster(admin.api, good, 'GSDN_Site_Master.xlsm');
    expect(macro.status).toBe(422);
    expect(macro.body).toMatchObject({ code: 'template_rejected', reason: 'macros_not_allowed' });
    const none = await uploadMaster(admin.api, await masterFile([], { noMaster: true }));
    expect(none.body).toMatchObject({ code: 'template_rejected', reason: 'not_a_master' });
    expect((await logRows('not_a_master'))[0]!.user_id).toBe(admin.user.id);
    const tpl = await uploadMaster(admin.api, await masterFile([{ A: 1, B: 'X-1' }], { tpl: true }));
    expect(tpl.body).toMatchObject({ code: 'template_rejected', reason: 'is_pmis_template' });
    // a typed column whose header was removed: the structure check refuses it
    const broken = await uploadMaster(admin.api, await masterFile([{ A: 1, B: 'X-1' }], { dropHeader: 'AO' }));
    expect(broken.body).toMatchObject({ code: 'template_rejected', reason: 'structure_mismatch' });
    expect(broken.body.detail).toContain('CW Survey & Analysis Report / Actual Date');
    // the database refuses the staging to anyone else whatever the API did
    expect(await q(db, `SELECT count(*)::int AS n FROM master_reconciliation_runs WHERE created_by = $1`, [importer.user.id])).toEqual([{ n: 0 }]);
  });
});

describe('legacy Master import: a known header alias (G2, migration 0070)', () => {
  it('accepts CL3 "IP Router" for "Indoor IP Router" and reports it, and still refuses any other renamed header', async () => {
    const admin = await plainAdmin(app, db);
    // the header of the owner file: the name part of CL3 is "IP Router"
    const aliased = await uploadMaster(admin.api, await masterFile([{ A: 1, B: 'X-ALIAS-1' }], { rename: { CL: 'IP Router' } }));
    expect(aliased.status).toBe(201);
    expect(aliased.body.structure).toMatchObject({ identified: true, columns_found: 187, aliased: [{ letter: 'CL', header: 'TE Installation Items / Indoor IP Router', in_file: 'TE Installation Items / IP Router' }], missing_typed: [] });
    expect(aliased.body.structure.extra).not.toContain('TE Installation Items / IP Router');
    // another renamed typed column is not an alias: the check stays exact
    const renamed = await uploadMaster(admin.api, await masterFile([{ A: 1, B: 'X-ALIAS-2' }], { rename: { AO: 'Real Date' } }));
    expect(renamed.status).toBe(422);
    expect(renamed.body).toMatchObject({ code: 'template_rejected', reason: 'structure_mismatch' });
    expect(renamed.body.detail).toContain('CW Survey & Analysis Report / Actual Date');
    // an alias of another column does not rescue it: CL3 may be "IP Router", not "Indoor Rack"
    const other = await uploadMaster(admin.api, await masterFile([{ A: 1, B: 'X-ALIAS-3' }], { rename: { CL: 'Indoor Rack' } }));
    expect(other.status).toBe(422);
    expect(other.body).toMatchObject({ code: 'template_rejected', reason: 'structure_mismatch' });
    // the alias list is data: the application role reads it and cannot write it
    expect(await q(db, `SELECT letter, alias FROM master_header_aliases WHERE is_active`)).toEqual([{ letter: 'CL', alias: 'IP Router' }]);
  });
});

describe('role and region aliases (Q8, Q10)', () => {
  it('lists the seeded aliases, lets an admin map a value with a reason (audited), and refuses everyone else', async () => {
    const admin = await plainAdmin(app, db);
    const regions = await admin.api.call('get', '/import-aliases?kind=region');
    expect(regions.status).toBe(200);
    expect(regions.body.items.find((x: { alias: string }) => x.alias === 'tripoli area')).toMatchObject({ target: '1', status: 'mapped' });
    const roles = await admin.api.call('get', '/import-aliases?kind=role');
    expect(roles.body.items.find((x: { alias: string }) => x.alias === 'site engineer')).toMatchObject({ status: 'ambiguous', target: null });
    expect(roles.body.items.filter((x: { status: string }) => x.status === 'mapped')).toHaveLength(0);
    expect(roles.body.can_edit).toBe(true);

    const code = `MI_ROLE_${Date.now()}`;
    await db.query(`INSERT INTO roles (code, name_en) VALUES ($1, 'Import probe role')`, [code]);
    const alias = `probe staff ${Date.now()}`;
    expect((await admin.api.call('put', '/import-aliases', { kind: 'role', alias, target: code, reason: '' })).status).toBe(422);
    const saved = await admin.api.call('put', '/import-aliases', { kind: 'role', alias, label: 'Probe Staff', target: code, reason: 'owner mapping test' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ alias, status: 'mapped', target: code });
    const reg = await admin.api.call('put', '/import-aliases', { kind: 'region', alias: `wm zone ${Date.now()}`, target: '3', reason: 'another spelling' });
    expect(reg.body).toMatchObject({ target: '3', status: 'mapped' });
    expect((await q(db, `SELECT 1 FROM audit_log WHERE action = 'import_alias.save' AND entity_id = $1 AND reason = 'owner mapping test'`, [alias]))).toHaveLength(1);

    const viewer = await actor(app, db, { grants: G('templates', 'view'), regions: null, modules: null });
    expect((await viewer.api.call('get', '/import-aliases?kind=role')).body.can_edit).toBe(false);
    expect((await viewer.api.call('put', '/import-aliases', { kind: 'region', alias: 'x zone', target: '3', reason: 'not mine' })).status).toBe(403);
  });
});

describe('Q11: the Issue Log in the Master columns GA:GE', () => {
  it('projects the oldest open issue, else the latest closed one, and appends "+N more" to the remark', async () => {
    const site = await makeSite(db, R, { prefix: 'MIQ' });
    const add = async (title: string, raised: string, status: string, remark: string | null, resolved: string | null = null): Promise<void> => {
      await db.query(`INSERT INTO register_records (register_key, site_id, region_id, state, is_current, version_no, data, entity_id)
        VALUES ('issues', $1, $2, 'approved', true, 1, $3::jsonb, gen_random_uuid())`,
        [site.id, R, JSON.stringify({ pending_issue: title, raised_date: raised, issue_status: status, remark, resolution_date: resolved })]);
    };
    await add('Closed long ago', '2026-01-01', 'Closed', 'old', '2026-01-03');
    await add('Closed lately', '2026-01-05', 'Closed', 'late', '2026-02-01');
    let cells = await issueCells(site.id);
    expect(cells).toMatchObject({ GA: 'Closed lately', GD: 'Closed', GE: 'late (+1 more)', count: 2 });
    await add('Open newer', '2026-02-10', 'Open', null);
    await add('Open older', '2026-02-02', 'Open', 'first');
    cells = await issueCells(site.id);
    expect(cells).toMatchObject({ GA: 'Open older', GC: '2026-02-02', GD: 'Open', GE: 'first (+3 more)', count: 4 });
  });
});
