import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, startApp, superDb } from './helpers';
import { Team } from './reg-helpers';
import { day, downloadTemplate, fillTemplate, load, tplTeam, uploadFile } from './tpl-helpers';
import { giveSiteApprove, giveSiteGrants, taskRow } from './tpl-stream-helpers';
import { plainAdmin, makeSite, makeTask, setCell } from './wf-helpers';

/**
 * Migration 0051: TPL-MASTER, the whole Master layout as one approved template. The As-Built register (no other suite sets its cells) and the tasks B4 and D5 in
 * region 1. The suites that issue new template versions share the advisory lock 770101. Dates are fixed past dates.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 1;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const kvOf = (wb: ExcelJS.Workbook): Map<string, ExcelJS.CellValue> => {
  const m = new Map<string, ExcelJS.CellValue>();
  wb.getWorksheet('_tpl')!.eachRow((r) => m.set(String(r.getCell(1).value), r.getCell(2).value));
  return m;
};
const headersOf = (ws: ExcelJS.Worksheet): string[] => {
  const out: string[] = [];
  for (let c = 1; c <= ws.getRow(1).cellCount; c++) out.push(String(ws.getRow(1).getCell(c).value));
  return out;
};
const rowsOf = async (api: Api, id: string): Promise<Record<string, any>[]> => {
  const res = await api.call('get', `/import-batches/${id}/rows`);
  expect(res.status).toBe(200);
  return res.body.items;
};
const submit = async (api: Api, id: string, version: number | string): Promise<Record<string, any>> => {
  const r = await api.call('post', `/import-batches/${id}/submit`, undefined, { 'If-Match': `"${version}"` });
  expect(r.status).toBe(200);
  return r.body as Record<string, any>;
};
const decide = (api: Api, id: string, version: number | string, body: Record<string, unknown>) => api.call('post', `/import-batches/${id}/decisions`, body, { 'If-Match': `"${version}"` });

const M = {
  site: 'Site ID', b4Aat: 'CW Survey & Analysis Report / AAT SE Name', b4Plan: 'CW Survey & Analysis Report / Planned Date', b4Act: 'CW Survey & Analysis Report / Actual Date',
  d5Plan: 'TE MOS / Planned Date', d5Act: 'TE MOS / Actual Date', calc: 'Milestone / PRE-CW Completion Date',
} as const;

interface MasterTeam { as: Team; siteId: string; siteCode: string; tasks: Record<string, string> }

/** The As-Built register team of region 1 who also hold L1 and L2 of the tasks B4 and D5 of one site. */
async function masterTeam(): Promise<MasterTeam> {
  const as = await tplTeam(app, db, 'as_built', 'as_built', R);
  await giveSiteGrants(db, as.entry.user.id, R);
  await giveSiteApprove(db, as.approve.user.id, R);
  const site = as.site;
  const tasks: Record<string, string> = {};
  for (const code of ['B4', 'D5']) {
    tasks[code] = await makeTask(db, site, code, 'open');
    await setCell(db, code, R, 'entry', { user: [as.entry.user.id] });
    await setCell(db, code, R, 'approve', { user: [as.approve.user.id] });
  }
  return { as, siteId: site.id, siteCode: site.code, tasks };
}

describe('download', () => {
  // the version of a download is read while no other suite issues a new one
  beforeEach(async () => { await db.query('SELECT pg_advisory_lock(770101)'); });
  afterEach(async () => { await db.query('SELECT pg_advisory_unlock(770101)'); });
  it('issues the whole Master layout: 187 columns with the Master names in Master order, a sheet per register the caller may use, grey locked columns for what is not read', async () => {
    const m = await masterTeam();
    const dl = await downloadTemplate(m.as.entry.api, 'TPL-MASTER');
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="TPL-MASTER_v\d+_\d{4}-\d{2}-\d{2}\.xlsx"$/);
    const wb = await load(dl.buffer);
    const kv = kvOf(wb);
    const version = (await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-MASTER'`))[0]!.v;
    expect(kv.get('template_id')).toBe('TPL-MASTER');
    expect(Number(kv.get('version'))).toBe(version);
    expect(kv.get('kind')).toBe('master');
    expect(kv.get('data_sheet')).toBe('Master');
    expect(wb.getWorksheet('_tpl')!.state).toBe('veryHidden');
    const names = wb.worksheets.map((w) => w.name);
    expect(names[0]).toBe('Master');
    expect(names).toContain('As-Built');                       // the register the caller may view
    expect(names).not.toContain('GECOL');                      // a register the caller has no right on is not offered
    expect(names).toEqual(expect.arrayContaining(['Instructions', 'Columns', '_lists', '_tpl']));
    const ws = wb.getWorksheet('Master')!;
    const h = headersOf(ws);
    expect(h).toHaveLength(187);
    expect(h[0]).toBe('#');
    expect(h[1]).toBe('Site ID');
    expect(h[20]).toBe('Baseline / Site Release Date');            // Master column U
    expect(h[40]).toBe(M.b4Act);                                   // AO
    expect(h[116]).toBe('On-Air / On-Air Planned Date');           // DM
    expect(h[186]).toBe('Issue & Remark / Remark');                // GE
    expect(sha(h.join('\u001f'))).toBe(kv.get('part:Master'));
    expect(kv.get('parts')).toBe(2);                                // the Master sheet and the As-Built sheet
    // which Master columns are read: the task fields of the streams only
    const how = new Map<string, string>();
    wb.getWorksheet('Columns')!.eachRow((r, n) => { if (n > 1 && r.getCell(1).value === 'Master') how.set(String(r.getCell(2).value), String(r.getCell(6).value)); });
    expect(how.get(M.b4Act)).toBe('typed');
    expect(how.get('TE MOS / Actual Date')).toBe('typed');
    expect(how.get(M.calc)).toBe('never read (grey)');
    expect(how.get('Coordinates / Latitude')).toBe('never read (grey)');
    expect(how.get('CW Dismantle (RN) / CW RN Date')).toBe('never read (grey)');       // the Dismantle register owns it
    expect(how.get('Issue & Remark / Remark')).toBe('never read (grey)');
    expect(how.get('Milestone / Site Release Date')).toBe('never read (grey)');        // a milestone is calculated
    // every download is audited, with the sheets
    const au = await q<{ after: { kind: string; sheets: { sheet: string }[] } }>(db, `SELECT after FROM audit_log WHERE action = 'template_download' AND entity_id = 'TPL-MASTER' AND actor_id = $1`, [m.as.entry.user.id]);
    expect(au).toHaveLength(1);
    expect(au[0]!.after.kind).toBe('master');
    expect(au[0]!.after.sheets.map((s) => s.sheet)).toEqual(['Master', 'As-Built']);

    // an admin sees every register sheet
    const admin = await plainAdmin(app, db);
    const all = await load((await downloadTemplate(admin.api, 'TPL-MASTER')).buffer);
    expect(all.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(['Master', 'RF & Design', 'Acquisition', 'PR-PO', 'GECOL', 'HLC', 'Permits & HSE', 'WH', 'Quality Inspections',
      'Change Control', 'Readiness & Handover', 'Risk Register', 'As-Built', 'Dismantle', 'Issue Log', 'Meetings', 'Contractors']));
    // the header rows of the registers are those of the register templates
    const gecolHeaders = headersOf(all.getWorksheet('GECOL')!);
    const reg = headersOf((await load((await downloadTemplate(admin.api, 'TPL-GECOL')).buffer)).getWorksheet('Data')!);
    expect(gecolHeaders).toEqual(reg);
  });

  it('pre-fills the site rows for information: the Master row number, name, region and scope, the typed task values, and the milestone dates', async () => {
    const m = await masterTeam();
    await db.query(`UPDATE task_instances SET actual_date = '2026-02-02', "values" = '{"aat_se_name": "Eng One"}' WHERE id = $1`, [m.tasks.B4]);
    await makeTask(db, m.as.site, 'MS2', 'approved', { actualDate: '2026-03-03' });
    await db.query(`UPDATE sites SET project_phase = 'Phase 1', scope_gecol_power = 'na' WHERE id = $1`, [m.siteId]);
    const dl = await downloadTemplate(m.as.entry.api, 'TPL-MASTER', `?site_ids=${m.siteId}`);
    expect(dl.status).toBe(200);
    const wb = await load(dl.buffer);
    expect(kvOf(wb).get('prefilled')).toBe('yes');
    const ws = wb.getWorksheet('Master')!;
    const h = headersOf(ws);
    const cell = (header: string): ExcelJS.CellValue => ws.getRow(2).getCell(h.indexOf(header) + 1).value;
    expect(cell('Site ID')).toBe(m.siteCode);
    expect(String(cell('#'))).toBe('1');
    expect(cell('Identification / Site Name')).toBe(`Site ${m.siteCode}`);
    expect(cell('Identification / Region')).toBe('Tripoli');
    expect(cell('Project Phase')).toBe('Phase 1');
    expect(cell('CW SOW / GECOL Power')).toBe('N/A');
    expect(cell(M.b4Act)).toEqual(day('2026-02-02'));
    expect(cell(M.b4Aat)).toBe('Eng One');
    expect(cell(M.calc)).toEqual(day('2026-03-03'));
    // the register sheet holds the records in force of the register
    expect(wb.getWorksheet('As-Built')).toBeTruthy();
  });
});

describe('upload: split into one batch per part', () => {
  // a download and its upload must see the same TPL-MASTER version: the suites that issue new versions hold the same lock
  beforeEach(async () => { await db.query('SELECT pg_advisory_lock(770101)'); });
  afterEach(async () => { await db.query('SELECT pg_advisory_unlock(770101)'); });
  it('stages the Master sheet as one batch per stream and each register sheet as its own, grouped; each follows its own flow; warnings for what GSDN Workspace does not own', async () => {
    const m = await masterTeam();
    const dl = await downloadTemplate(m.as.entry.api, 'TPL-MASTER');
    const withMaster = await fillTemplate(dl.buffer, [{
      [M.site]: m.siteCode, [M.b4Aat]: 'Eng Master', [M.b4Plan]: day('2026-02-01'), [M.b4Act]: day('2026-02-02'), [M.d5Plan]: day('2026-03-01'), [M.d5Act]: day('2026-03-02'),
      [M.calc]: day('2026-05-05'),                                 // a calculated column: ignored with a warning
    }], { sheet: 'Master' });
    const withAsBuilt = await fillTemplate(withMaster, [{ 'Site ID': m.siteCode, 'As-Built Date': day('2026-04-01') }], { sheet: 'As-Built' });
    const file = await fillTemplate(withAsBuilt, [], { sheet: 'Master', edit: (wb) => {
      const ws = wb.getWorksheet('Master')!;
      ws.getRow(1).getCell(200).value = 'My own notes';            // a column GSDN Workspace does not own
      ws.getRow(2).getCell(200).value = 'see me';
      wb.addWorksheet('Scratch').addRow(['a sheet GSDN Workspace does not know']);
    } });
    const res = await uploadFile(m.as.entry.api, file);
    expect(res.status).toBe(202);
    const body = res.body as Record<string, any>;
    expect(body.group_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.parts).toHaveLength(3);
    const part = (k: string): Record<string, any> => body.parts.find((p: Record<string, any>) => (p.stream ?? p.register_key) === k);
    expect(part('CW')).toMatchObject({ template_id: 'TPL-SITE-CW', source: 'master_template', part_sheet: 'Master', group_id: body.group_id, status: 'validated' });
    expect(part('TE')).toMatchObject({ template_id: 'TPL-SITE-TE', source: 'master_template', part_sheet: 'Master' });
    expect(part('as_built')).toMatchObject({ template_id: 'TPL-ASB', source: 'master_template', part_sheet: 'As-Built', register_key: 'as_built' });
    expect(body.id).toBe(body.parts[0].id);
    const codes = body.warnings.map((w: { code: string }) => w.code).sort();
    expect(codes).toEqual(['column_not_owned', 'extra_column', 'unknown_sheet']);
    expect(body.warnings.find((w: { code: string }) => w.code === 'column_not_owned')).toMatchObject({ sheet: 'Master', column: M.calc, count: 1 });
    expect(body.warnings.find((w: { code: string }) => w.code === 'extra_column')).toMatchObject({ column: 'My own notes' });
    expect(body.warnings.find((w: { code: string }) => w.code === 'unknown_sheet')).toMatchObject({ sheet: 'Scratch' });

    // the comparison report: every row keeps its source (sheet and file row) and its differences
    const cwRows = await rowsOf(m.as.entry.api, part('CW').id);
    expect(cwRows).toHaveLength(1);
    expect(cwRows[0]).toMatchObject({ task_code: 'B4', sheet: 'Master', source_ref: 'Master!2', action: 'update', key: `${m.siteCode} / B4` });
    expect(cwRows[0]!.diff).toEqual({ aat_se_name: { old: null, new: 'Eng Master' }, planned_date: { old: null, new: '2026-02-01' }, actual_date: { old: null, new: '2026-02-02' } });
    const teRows = await rowsOf(m.as.entry.api, part('TE').id);
    expect(teRows.map((r) => r.task_code)).toEqual(['D5']);
    expect(teRows[0]!.diff).toEqual({ planned_date: { old: null, new: '2026-03-01' }, actual_date: { old: null, new: '2026-03-02' } });
    const abRows = await rowsOf(m.as.entry.api, part('as_built').id);
    expect(abRows[0]).toMatchObject({ sheet: 'As-Built', source_ref: 'As-Built!2', action: 'create', site_code: m.siteCode });
    // the batches of one file are listed by group
    const list = await m.as.entry.api.call('get', `/import-batches?group_id=${body.group_id}`);
    expect(list.body.items.map((i: { id: string }) => i.id).sort()).toEqual(body.parts.map((p: { id: string }) => p.id).sort());
    expect((await m.as.entry.api.call('get', '/import-batches?group_id=nope')).status).toBe(422);

    // the stream part and the register part follow their own flow; the other stream part waits
    const cw = await submit(m.as.entry.api, part('CW').id, part('CW').version);
    expect(cw.outcome.submitted).toBe(1);
    expect((await taskRow(db, m.tasks.B4!)).state).toBe('in_approval');
    expect((await taskRow(db, m.tasks.D5!)).state).toBe('open');
    expect((await m.as.entry.api.call('get', `/import-batches/${part('TE').id}`)).body.status).toBe('validated');
    const ab = await submit(m.as.entry.api, part('as_built').id, part('as_built').version);
    expect(ab.outcome.submitted).toBe(1);
    const dCw = await decide(m.as.approve.api, part('CW').id, cw.version, { action: 'approve', scope: 'all' });
    expect(dCw.status).toBe(200);
    expect(dCw.body.status).toBe('approved');
    expect(await taskRow(db, m.tasks.B4!)).toMatchObject({ state: 'approved', actual_date: '2026-02-02', planned_date: '2026-02-01', values: { aat_se_name: 'Eng Master' } });
    const dAb = await decide(m.as.approve.api, part('as_built').id, ab.version, { action: 'approve', scope: 'all' });
    expect(dAb.status).toBe(200);
    expect(dAb.body.status).toBe('approved');
    const rec = await q<{ state: string; data: { as_built_date: string } }>(db, `SELECT state, data FROM register_records WHERE register_key = 'as_built' AND site_id = $1 AND is_current`, [m.siteId]);
    expect(rec[0]).toMatchObject({ state: 'approved', data: { as_built_date: '2026-04-01' } });
    const grp = await q<{ action: string }>(db, `SELECT action FROM audit_log WHERE entity_type = 'import_group' AND entity_id = $1`, [body.group_id]);
    expect(grp).toEqual([{ action: 'import_master_upload' }]);
    // now the second stream part
    const te = await submit(m.as.entry.api, part('TE').id, part('TE').version);
    expect(te.outcome.submitted).toBe(1);
    expect((await taskRow(db, m.tasks.D5!)).state).toBe('in_approval');
  });

  it('skips a part the caller may not import with the reason, and refuses a Master sheet whose header was changed, a retired file and a file with nothing to enter', async () => {
    const m = await masterTeam();
    const admin = await plainAdmin(app, db);
    const dl = await downloadTemplate(admin.api, 'TPL-MASTER');
    // the admin's file has the GECOL sheet; the caller has no right on GECOL
    const f1 = await fillTemplate(dl.buffer, [{ [M.site]: m.siteCode, [M.b4Act]: day('2026-02-02') }], { sheet: 'Master' });
    const f2 = await fillTemplate(f1, [{ 'Site ID': m.siteCode, 'GECOL PR No.': 'GP-9', 'GECOL Request Date': day('2026-01-05') }], { sheet: 'GECOL' });
    const res = await uploadFile(m.as.entry.api, f2);
    expect(res.status).toBe(202);
    expect(res.body.parts).toHaveLength(1);
    expect(res.body.parts[0]).toMatchObject({ stream: 'CW' });
    const skipped = res.body.warnings.find((w: { code: string }) => w.code === 'part_skipped');
    expect(skipped).toMatchObject({ sheet: 'GECOL' });
    expect(skipped.message).toContain('GECOL');
    // the GECOL part alone: nothing can be staged, so the file is refused (import_not_allowed) and logged
    const only = await fillTemplate(dl.buffer, [{ 'Site ID': m.siteCode, 'GECOL PR No.': 'GP-9', 'GECOL Request Date': day('2026-01-05') }], { sheet: 'GECOL' });
    const refused = await uploadFile(m.as.entry.api, only);
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'template_rejected', reason: 'import_not_allowed' });
    // a Master sheet that lost an issued header is refused (the other sheets are not enough)
    const missing = await fillTemplate(f1, [], { sheet: 'Master', edit: (wb) => { wb.getWorksheet('Master')!.getRow(1).getCell(41).value = 'Renamed header'; } });
    const mm = await uploadFile(m.as.entry.api, missing);
    expect(mm.status).toBe(422);
    expect(mm.body).toMatchObject({ code: 'template_rejected', reason: 'checksum_mismatch' });
    expect(mm.body.detail).toContain(M.b4Act);
    // a claimed checksum that is not the issued one
    const forged = await fillTemplate(f1, [], { sheet: 'Master', edit: (wb) => { wb.getWorksheet('_tpl')!.eachRow((r) => { if (String(r.getCell(1).value) === 'header_checksum') r.getCell(2).value = 'f'.repeat(64); }); } });
    expect((await uploadFile(m.as.entry.api, forged)).body).toMatchObject({ reason: 'checksum_mismatch' });
    // only calculated columns filled: there is nothing GSDN Workspace can enter
    const calcOnly = await fillTemplate(dl.buffer, [{ [M.site]: m.siteCode, [M.calc]: day('2026-05-05') }], { sheet: 'Master' });
    const none = await uploadFile(m.as.entry.api, calcOnly);
    expect(none.status).toBe(422);
    expect(none.body).toMatchObject({ code: 'validation_failed' });
    // a formula in a typed cell is a cell error of its row
    const formula = await fillTemplate(dl.buffer, [{ [M.site]: m.siteCode, [M.b4Act]: { formula: '1+1', result: 2 } as unknown as ExcelJS.CellValue }], { sheet: 'Master' });
    const fr = await uploadFile(m.as.entry.api, formula);
    expect(fr.status).toBe(202);
    const rows = await rowsOf(m.as.entry.api, fr.body.parts[0].id);
    expect(rows[0]).toMatchObject({ action: 'error', task_code: 'B4' });
    expect(rows[0]!.errors[0]).toMatchObject({ code: 'formula_not_allowed', column: M.b4Act });
    // no import right (permission denied): 403 before the file is read
    expect((await uploadFile(m.as.approve.api, dl.buffer)).status).toBe(403);
    // a site the caller does not hold is the same error as an unknown one, on the stream part
    const far = await makeSite(db, 3, { prefix: 'FAR' });
    await makeTask(db, far, 'B4', 'open');
    const out = await fillTemplate(dl.buffer, [{ [M.site]: far.code, [M.b4Act]: day('2026-02-02') }], { sheet: 'Master' });
    const o = await uploadFile(m.as.entry.api, out);
    expect(o.status).toBe(202);
    expect((await rowsOf(m.as.entry.api, o.body.parts[0].id))[0]!.errors[0]).toMatchObject({ code: 'site_not_in_scope' });
  }, 120_000); // waits for the template-version lock (770101) while the other suites issue versions
});

describe('template versions', () => {
  beforeEach(async () => { await db.query('SELECT pg_advisory_lock(770101)'); });
  afterEach(async () => { await db.query('SELECT pg_advisory_unlock(770101)'); });

  it('issues a new version of TPL-MASTER when a sheet changes and refuses the file of the old version', async () => {
    const m = await masterTeam();
    const v0 = (await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-MASTER'`))[0]!.v;
    const dl = await downloadTemplate(m.as.entry.api, 'TPL-MASTER');
    const oldFile = await fillTemplate(dl.buffer, [{ [M.site]: m.siteCode, [M.b4Act]: day('2026-02-02') }], { sheet: 'Master' });
    await db.query(`UPDATE template_parts SET sheet_name = 'As Built Register' WHERE template_id = 'TPL-MASTER' AND register_key = 'as_built'`);
    try {
      expect((await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-MASTER'`))[0]!.v).toBe(v0 + 1);
      const res = await uploadFile(m.as.entry.api, oldFile);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'template_rejected', reason: 'outdated_version' });
      expect(res.body.detail).toContain(`version ${v0} of TPL-MASTER`);
      const au = await q(db, `SELECT 1 FROM audit_log WHERE action = 'template_version_issued' AND entity_id = 'TPL-MASTER' AND (after ->> 'version')::int = $1`, [v0 + 1]);
      expect(au).toHaveLength(1);
      const fresh = await load((await downloadTemplate(m.as.entry.api, 'TPL-MASTER')).buffer);
      expect(fresh.worksheets.map((w) => w.name)).toContain('As Built Register');
      expect(kvOf(fresh).get('version')).toBe(v0 + 1);
    } finally {
      await db.query(`UPDATE template_parts SET sheet_name = 'As-Built' WHERE template_id = 'TPL-MASTER' AND register_key = 'as_built'`);
    }
    // a change of a register field issues a new Master version as well (a register sheet is part of the Master)
    const v1 = (await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-MASTER'`))[0]!.v;
    expect(v1).toBe(v0 + 2);
    const f = await db.query(`INSERT INTO field_definitions (entity_type, code, label_en, data_type, in_templates, is_active) VALUES ('meeting', 'tpl_probe_m', 'Probe M', 'text', true, true) RETURNING id`);
    try {
      expect((await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-MASTER'`))[0]!.v).toBe(v1 + 1);
    } finally {
      await db.query(`UPDATE field_definitions SET is_active = false WHERE id = $1`, [f.rows[0].id]);
    }
  });
});
