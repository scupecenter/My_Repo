import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, startApp, superDb } from './helpers';
import { G } from './reg-helpers';
import { day, downloadTemplate, fillTemplate, load, uploadFile } from './tpl-helpers';
import { SOUT, SR, SITE_ENTRY_GRANTS, filled, moreSite, streamTeam, taskRow } from './tpl-stream-helpers';
import { actor, addAssignment, makeSite, makeTask, plainAdmin, setCell } from './wf-helpers';

/**
 * Migration 0051: the Site Register stream templates (TPL-SITE-DA, -CW, -TE, -CL). The tasks A2, A5, B4 ... of workflow v1 in region 7, where no other suite sets
 * matrix cells. Dates are fixed past dates; nothing depends on the weekday or the collation. The suites that issue new template versions share the advisory lock 770101.
 */
let app: NestExpressApplication;
let db: PgClient;

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
const rowsOf = async (api: Api, id: string, query = ''): Promise<Record<string, any>[]> => {
  const res = await api.call('get', `/import-batches/${id}/rows${query}`);
  expect(res.status).toBe(200);
  return res.body.items;
};
const byTask = (rows: Record<string, any>[], code: string): Record<string, any> => {
  const r = rows.find((x) => x.task_code === code);
  if (!r) throw new Error(`no row for ${code}: ${JSON.stringify(rows.map((x) => x.task_code))}`);
  return r;
};
const logRows = (reason: string): Promise<{ message: string; source: string; context: Record<string, unknown>; user_id: string }[]> =>
  q(db, `SELECT message, source, context, user_id FROM system_log WHERE source = 'template-check' AND context ->> 'reason' = $1 ORDER BY id DESC LIMIT 5`, [reason]);
const upload = async (api: Api, buf: Buffer, fields: Record<string, string> = {}): Promise<Record<string, any>> => {
  const res = await uploadFile(api, buf, 'filled.xlsx', fields);
  if (res.status !== 202) throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as Record<string, any>;
};
const submit = (api: Api, id: string, version: number | string, expectStatus = 200): Promise<Record<string, any>> =>
  api.call('post', `/import-batches/${id}/submit`, undefined, { 'If-Match': `"${version}"` }).then((r) => {
    expect(r.status).toBe(expectStatus);
    return r.body as Record<string, any>;
  });
const decide = (api: Api, id: string, version: number | string, body: Record<string, unknown>) =>
  api.call('post', `/import-batches/${id}/decisions`, body, { 'If-Match': `"${version}"` });

describe('catalogue and download', () => {
  it('lists the four stream templates and TPL-MASTER for a Site Register user, and none for a register-only user', async () => {
    const t = await streamTeam(app, db, { B4: 'open' });
    const list = await t.entry.api.call('get', '/templates');
    expect(list.status).toBe(200);
    const ids: string[] = list.body.items.map((i: { template_id: string }) => i.template_id);
    expect(ids).toEqual(expect.arrayContaining(['TPL-MASTER', 'TPL-SITE-DA', 'TPL-SITE-CW', 'TPL-SITE-TE', 'TPL-SITE-CL']));
    const cw = list.body.items.find((i: { template_id: string }) => i.template_id === 'TPL-SITE-CW');
    expect(cw).toMatchObject({ kind: 'data_import', template_kind: 'stream', stream: 'CW', register_key: null, module_key: 'sites', is_active: true });
    expect(cw.current_version).toBeGreaterThanOrEqual(1);
    expect(list.body.items.find((i: { template_id: string }) => i.template_id === 'TPL-MASTER')).toMatchObject({ template_kind: 'master', stream: null });
    expect(ids.indexOf('TPL-MASTER')).toBeLessThan(ids.indexOf('TPL-SITE-DA'));

    const regOnly = await actor(app, db, { grants: [...G('gecol', 'view'), ...G('templates', 'view')], regions: [SR], modules: null });
    const mine: string[] = (await regOnly.api.call('get', '/templates')).body.items.map((i: { template_id: string }) => i.template_id);
    expect(mine).toContain('TPL-GECOL');
    expect(mine.filter((i) => i.startsWith('TPL-SITE') || i === 'TPL-MASTER')).toEqual([]);
  });

  it('issues a file with the _tpl sheet, the headers in Master order with the Master names, grey locked columns and a Columns sheet; every download is audited', async () => {
    const t = await streamTeam(app, db, { B4: 'open' });
    const dl = await downloadTemplate(t.entry.api, 'TPL-SITE-CW');
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="TPL-SITE-CW_v\d+_\d{4}-\d{2}-\d{2}\.xlsx"$/);
    const wb = await load(dl.buffer);
    const kv = kvOf(wb);
    const version = (await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-SITE-CW'`))[0]!.v;
    expect(kv.get('template_id')).toBe('TPL-SITE-CW');
    expect(Number(kv.get('version'))).toBe(version);
    expect(kv.get('kind')).toBe('stream');
    expect(kv.get('stream')).toBe('CW');
    expect(kv.get('register_key')).toBe('');
    expect(kv.get('prefilled')).toBe('no');
    expect(wb.getWorksheet('_tpl')!.state).toBe('veryHidden');
    const ws = wb.getWorksheet('Data')!;
    const h = headersOf(ws);
    expect(sha(h.join('\u001f'))).toBe(kv.get('header_checksum'));
    expect(h.slice(0, 4)).toEqual(['Site ID', 'Site Name', 'Region', 'Delivery Scenario']);
    // Master column order: B4 (AM, AN, AO) then B5 (AP, AQ), B7 (AT, AU), the PRE-CW milestone (AW), CW MOS (AY, AZ), the tower and adaption items, the CW PAC columns
    const order = ['B4 AAT SE Name', 'B4 CW Survey Planned', 'B4 CW Survey Actual', 'B5 Analysis Type', 'B5 Analysis Result', 'B7 CW DN Submitted', 'B7 CW DN Approved',
      'MS2 PRE-CW Completion (milestone)', 'B8 CW MOS Planned', 'B8 CW MOS Actual', 'B10 Tower Foundation', 'B11 Site GND', 'B11 CW Actual Start', 'B11 CW Actual End',
      'B13 CW PAC Planned', 'B13 CW Snags Found', 'B13 CW As-Built Submitted (As-Built register)', 'B13 CW PAC Actual', 'MS4 Site RFI (milestone)'];
    const at = order.map((x) => h.indexOf(x));
    expect(at.every((i) => i > 3)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // a task without a Master column still has its two dates; Dismantle tasks are not on any stream template
    expect(h).toEqual(expect.arrayContaining(['B6 Planned Date', 'B6 Actual Date', 'C1 Actual Date']));
    expect(h.some((x) => x.startsWith('E1 ') || x.startsWith('E2 '))).toBe(false);
    // the Columns sheet says which column is read and which never is (the dates the workflow sets and the register-owned fields are grey)
    const cs = wb.getWorksheet('Columns')!;
    const how = new Map<string, string>();
    cs.eachRow((r, n) => { if (n > 1) how.set(String(r.getCell(2).value), String(r.getCell(6).value)); });
    expect(how.get('B4 CW Survey Actual')).toBe('typed');
    expect(how.get('B7 CW DN Submitted')).toBe('never read (grey)');
    expect(how.get('B13 CW As-Built Submitted (As-Built register)')).toBe('never read (grey)');
    expect(how.get('MS2 PRE-CW Completion (milestone)')).toBe('never read (grey)');
    expect(how.get('C1 Actual Date')).toBe('never read (grey)');          // its date comes from the GECOL register
    const cols = cs.getColumn(2);
    expect(cols).toBeTruthy();
    expect((ws as unknown as { sheetProtection: unknown }).sheetProtection).toBeTruthy();
    expect(wb.getWorksheet('Instructions')!.state).toBe('visible');
    // drop-downs for the lists of the Master Setting sheet
    const lists = wb.getWorksheet('_lists')!;
    const heads: string[] = [];
    lists.getRow(1).eachCell((c) => heads.push(String(c.value)));
    expect(heads).toEqual(expect.arrayContaining(['B5:v:analysis_type', 'B10:v:tower_foundation']));
    const col = heads.indexOf('B5:v:analysis_type') + 1;
    const vals: string[] = [];
    lists.getColumn(col).eachCell({ includeEmpty: false }, (c, r) => { if (r > 1 && c.value !== null) vals.push(String(c.value)); });
    expect(vals).toEqual(['STA', 'ST', 'N/A']);
    // audited
    const au = await q<{ after: { version: number; prefill: boolean; kind: string; stream: string } }>(db,
      `SELECT after FROM audit_log WHERE action = 'template_download' AND entity_id = 'TPL-SITE-CW' AND actor_id = $1`, [t.entry.user.id]);
    expect(au).toHaveLength(1);
    expect(au[0]!.after).toMatchObject({ version, prefill: false, kind: 'stream', stream: 'CW' });
  });

  it('pre-fills the task values of the caller regions, with the grey columns filled for information, and refuses another stream task', async () => {
    const t = await streamTeam(app, db, { B4: 'open', B5: 'locked' });
    await db.query(`UPDATE task_instances SET planned_date = '2026-02-01', actual_date = '2026-02-02', "values" = '{"aat_se_name": "Eng One"}' WHERE id = $1`, [t.tasks.B4]);
    const ms = await makeTask(db, t.site, 'MS2', 'approved', { actualDate: '2026-03-03' });
    expect(ms).toBeTruthy();
    await db.query(`UPDATE task_instances SET submitted_date = '2026-02-03', approved_date = '2026-02-04' WHERE id = $1`, [await makeTask(db, t.site, 'B7', 'approved')]);
    const far = await makeSite(db, SOUT, { prefix: 'FAR' });
    await makeTask(db, far, 'B4', 'open');
    const cancelled = await makeSite(db, SR, { prefix: 'CAN', status: 'cancelled' });
    await makeTask(db, cancelled, 'B4', 'open');

    const dl = await downloadTemplate(t.entry.api, 'TPL-SITE-CW', '?prefill=true');
    expect(dl.status).toBe(200);
    const wb = await load(dl.buffer);
    expect(kvOf(wb).get('prefilled')).toBe('yes');
    const ws = wb.getWorksheet('Data')!;
    const h = headersOf(ws);
    const codes: string[] = [];
    ws.eachRow((r, n) => { if (n > 1 && r.getCell(1).value) codes.push(String(r.getCell(1).value)); });
    expect(codes).toContain(t.site.code);
    expect(codes).not.toContain(far.code);                       // outside the caller's regions
    expect(codes).not.toContain(cancelled.code);                 // cancelled sites are hidden
    const row = [...Array(ws.rowCount).keys()].map((i) => i + 1).find((n) => ws.getRow(n).getCell(1).value === t.site.code)!;
    const cell = (header: string): ExcelJS.CellValue => ws.getRow(row).getCell(h.indexOf(header) + 1).value;
    expect(cell('Site Name')).toBe(`Site ${t.site.code}`);
    expect(cell('Region')).toBe('Sebha');
    expect(cell('Delivery Scenario')).toBe('New Build');
    expect(cell('B4 CW Survey Planned')).toEqual(day('2026-02-01'));
    expect(cell('B4 CW Survey Actual')).toEqual(day('2026-02-02'));
    expect(cell('B4 AAT SE Name')).toBe('Eng One');
    expect(cell('MS2 PRE-CW Completion (milestone)')).toEqual(day('2026-03-03'));
    expect(cell('B7 CW DN Submitted')).toEqual(day('2026-02-03'));
    expect(cell('B7 CW DN Approved')).toEqual(day('2026-02-04'));
    // the grey cells are locked and shaded
    const fill = ws.getRow(row).getCell(h.indexOf('MS2 PRE-CW Completion (milestone)') + 1).fill as ExcelJS.FillPattern;
    expect(fill.fgColor?.argb).toBe('FFEDEFF0');
    const typed = ws.getRow(row).getCell(h.indexOf('B4 CW Survey Actual') + 1);
    expect(typed.protection?.locked).toBe(false);
    expect(ws.getRow(row).getCell(h.indexOf('MS2 PRE-CW Completion (milestone)') + 1).protection?.locked).not.toBe(false);   // locked is the default

    // for one task: its site only; a task of another stream is refused (wrong_template)
    const one = await downloadTemplate(t.entry.api, 'TPL-SITE-CW', `?task_id=${t.tasks.B4}`);
    expect(one.status).toBe(200);
    const teTask = await makeTask(db, t.site, 'D5', 'locked');
    const wrong = await downloadTemplate(t.entry.api, 'TPL-SITE-CW', `?task_id=${teTask}`);
    expect(wrong.status).toBe(422);
    expect(wrong.body).toMatchObject({ code: 'template_rejected', reason: 'wrong_template' });
    expect((await downloadTemplate(t.entry.api, 'TPL-SITE-CW', `?task_id=${'0'.repeat(8)}-0000-4000-8000-000000000000`)).status).toBe(404);
    // the audit row of the pre-filled download counts the rows
    const au = await q<{ after: { rows: number; prefill: boolean } }>(db, `SELECT after FROM audit_log WHERE action = 'template_download' AND entity_id = 'TPL-SITE-CW' AND actor_id = $1 ORDER BY id`, [t.entry.user.id]);
    expect(au[0]!.after.prefill).toBe(true);
    expect(au[0]!.after.rows).toBeGreaterThanOrEqual(1);
    expect(au.length).toBe(2);
  });

  it('shows a register-owned value in a pre-filled file only to a caller who may view that register in the region', async () => {
    const t = await streamTeam(app, db, { B13: 'open' });
    await db.query(
      `INSERT INTO register_records (entity_id, version_no, register_key, site_id, region_id, state, is_current, data, approved_at, current_level)
       VALUES (gen_random_uuid(), 1, 'as_built', $1, $2, 'approved', true, '{"cw_as_built_submitted": "Yes"}'::jsonb, now(), 3)`, [t.site.id, SR]);
    const valueFor = async (api: Api): Promise<ExcelJS.CellValue> => {
      const dl = await downloadTemplate(api, 'TPL-SITE-CW', '?prefill=true');
      expect(dl.status).toBe(200);
      const ws = (await load(dl.buffer)).getWorksheet('Data')!;
      const h = headersOf(ws);
      const col = h.findIndex((x) => x.includes('As-Built Submitted'));
      expect(col).toBeGreaterThanOrEqual(0);
      const row = [...Array(ws.rowCount).keys()].map((i) => i + 1).find((n) => ws.getRow(n).getCell(1).value === t.site.code)!;
      return ws.getRow(row).getCell(col + 1).value;
    };
    expect(await valueFor(t.entry.api)).toBeNull();                 // no As-Built module: the read-only cell stays empty
    await addAssignment(db, t.entry.user.id, { level: 'view', regions: [SR], modules: null, grants: G('as_built', 'view') });
    expect(await valueFor(t.entry.api)).toBe('Yes');                 // with the register's view in the region it is shown
  });

  it('refuses a caller without the right to download, or without the Site Register, and an unknown template (permission denied)', async () => {
    const noRight = await actor(app, db, { grants: [...G('sites', 'view'), ...G('templates', 'view')], regions: [SR], modules: null });
    const denied = await downloadTemplate(noRight.api, 'TPL-SITE-CW');
    expect(denied.status).toBe(403);
    expect((await downloadTemplate(noRight.api, 'TPL-MASTER')).status).toBe(403);
    const noModule = await actor(app, db, { grants: G('templates', 'view', 'download_documents'), regions: [SR], modules: null });
    const nm = await downloadTemplate(noModule.api, 'TPL-SITE-TE');
    expect(nm.status).toBe(403);
    expect(nm.body).toMatchObject({ code: 'module_forbidden' });
    expect((await downloadTemplate(noRight.api, 'TPL-SITE-XX')).status).toBe(404);
  });
});

describe('upload: match and validate', () => {
  it('matches each row to its site and tasks, lists one batch row per task with the diff, classifies unchanged tasks, and a blank cell never clears a value', async () => {
    const t = await streamTeam(app, db, { B4: 'open', B8: 'open', B13: 'open' });
    await db.query(`UPDATE task_instances SET planned_date = '2026-02-01', actual_date = '2026-02-02' WHERE id = $1`, [t.tasks.B4]);
    await db.query(`UPDATE task_instances SET planned_date = '2026-03-01' WHERE id = $1`, [t.tasks.B8]);
    const buf = await filled(t.entry.api, 'TPL-SITE-CW', [{
      'Site ID': t.site.code,
      'B4 CW Survey Planned': day('2026-02-10'),             // changed; its actual date stays (the cell is not typed)
      'B4 AAT SE Name': 'Eng Two',
      'B8 CW MOS Planned': day('2026-03-01'),                // the same as the task holds
      'B13 CW PAC Actual': day('2026-04-01'),
      'B13 CW Snags Found': 'yes',                           // a list value, case-insensitive
    }]);
    const batch = await upload(t.entry.api, buf);
    expect(batch).toMatchObject({ template_id: 'TPL-SITE-CW', status: 'validated', stream: 'CW', register_key: null, current_level: 1, levels_required: 2 });
    expect(batch.counts).toMatchObject({ update: 2, unchanged: 1, error: 0, create: 0 });
    const rows = await rowsOf(t.entry.api, batch.id);
    expect(rows.map((r) => r.task_code)).toEqual(['B4', 'B8', 'B13']);          // the column (Master) order of the file
    const b4 = byTask(rows, 'B4');
    expect(b4).toMatchObject({ action: 'update', key: `${t.site.code} / B4`, task_id: t.tasks.B4, site_code: t.site.code, sheet: 'Data', decision: 'pending', source_ref: `Data!2` });
    expect(b4.diff).toEqual({ planned_date: { old: '2026-02-01', new: '2026-02-10' }, aat_se_name: { old: null, new: 'Eng Two' } });
    expect(b4.errors).toEqual([]);
    expect(byTask(rows, 'B8')).toMatchObject({ action: 'unchanged', diff: {} });
    expect(byTask(rows, 'B13')).toMatchObject({ action: 'update' });
    expect(byTask(rows, 'B13').diff).toEqual({ actual_date: { old: null, new: '2026-04-01' }, snags_found: { old: null, new: 'Yes' } });
    // nothing has reached the tasks yet
    expect((await taskRow(db, t.tasks.B4!)).planned_date).toBe('2026-02-01');
    const au = await q<{ after: { stream: string; rows: number; update: number } }>(db, `SELECT after FROM audit_log WHERE action = 'import_batch_create' AND entity_id = $1`, [batch.id]);
    expect(au[0]!.after).toMatchObject({ stream: 'CW', rows: 3, update: 2 });
  });

  it('reports the cell errors of a row by header: a bad date, a value outside the list, an out-of-range date, a future actual date, a formula', async () => {
    const t = await streamTeam(app, db, { B4: 'open', B5: 'open' });
    const buf = await filled(t.entry.api, 'TPL-SITE-CW', [
      { 'Site ID': t.site.code, 'B4 CW Survey Planned': day('2019-01-01'), 'B4 CW Survey Actual': day('2035-12-30'), 'B5 Analysis Type': 'XYZ', 'B5 Actual Date': 'not a date',
        'B4 AAT SE Name': { formula: '1+1', result: 2 } as unknown as ExcelJS.CellValue },
    ]);
    const batch = await upload(t.entry.api, buf);
    const rows = await rowsOf(t.entry.api, batch.id);
    const b4 = byTask(rows, 'B4');
    const b5 = byTask(rows, 'B5');
    expect(b4.action).toBe('error');
    expect(b4.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ column: 'B4 AAT SE Name', code: 'formula_not_allowed' }),
      expect.objectContaining({ column: 'B4 CW Survey Planned', code: 'invalid_date' }),
    ]));
    expect(b5.action).toBe('error');
    expect(b5.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ column: 'B5 Analysis Type', code: 'not_in_list' }),
      expect.objectContaining({ column: 'B5 Actual Date', code: 'invalid_date' }),
    ]));
    // a future actual date is refused by the same rule as the task screen (wf_save_entry), on its own
    const buf2 = await filled(t.entry.api, 'TPL-SITE-CW', [{ 'Site ID': t.site.code, 'B4 CW Survey Actual': day('2035-12-30') }]);
    const rows2 = await rowsOf(t.entry.api, (await upload(t.entry.api, buf2)).id);
    expect(byTask(rows2, 'B4')).toMatchObject({ action: 'error' });
    expect(byTask(rows2, 'B4').errors[0]).toMatchObject({ column: 'B4 CW Survey Actual', code: 'future_date' });
  });

  it('refuses an unknown site, a site outside the regions, a task the site does not have, a repeated task and a task row of a not-owned holder', async () => {
    const t = await streamTeam(app, db, { B4: 'open' });
    const far = await makeSite(db, SOUT, { prefix: 'FAR' });
    await makeTask(db, far, 'B4', 'open');
    const other = await actor(app, db, { level: 'entry', grants: SITE_ENTRY_GRANTS, regions: [SR], modules: null });
    const site2 = await makeSite(db, SR, { prefix: 'SRT' });
    const foreign = await makeTask(db, site2, 'B4', 'open');
    await setCell(db, 'B4', SR, 'entry', { user: [other.user.id] });         // the entry cell of B4 now names somebody else
    const buf = await filled(t.entry.api, 'TPL-SITE-CW', [
      { 'Site ID': 'NO-SUCH-SITE', 'B4 CW Survey Actual': day('2026-01-10') },
      { 'Site ID': far.code, 'B4 CW Survey Actual': day('2026-01-10') },
      { 'Site ID': site2.code, 'B4 CW Survey Actual': day('2026-01-10') },
      { 'Site ID': t.site.code, 'B5 Actual Date': day('2026-01-10') },
    ]);
    const batch = await upload(t.entry.api, buf);
    const rows = await rowsOf(t.entry.api, batch.id);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.action === 'error')).toBe(true);
    expect(rows[0]!.errors[0]).toMatchObject({ code: 'site_not_in_scope', column: 'Site ID' });
    expect(rows[1]!.errors[0]).toMatchObject({ code: 'site_not_in_scope' });             // the same answer for an unknown site and one outside the regions
    expect(rows[2]!.errors[0]).toMatchObject({ code: 'not_entry_holder', column: 'B4 CW Survey Actual' });
    expect(rows[2]!.task_id).toBe(foreign);
    expect(rows[3]!.errors[0]).toMatchObject({ code: 'task_not_on_site', column: 'B5 Actual Date' });
    expect((await taskRow(db, foreign)).state).toBe('open');

    // the same task twice in one file: the second row is an error
    await setCell(db, 'B4', SR, 'entry', { user: [t.entry.user.id] });
    const dup = await filled(t.entry.api, 'TPL-SITE-CW', [
      { 'Site ID': t.site.code, 'B4 CW Survey Actual': day('2026-01-10') },
      { 'Site ID': t.site.code, 'B4 CW Survey Actual': day('2026-01-11') },
    ]);
    const rows2 = await rowsOf(t.entry.api, (await upload(t.entry.api, dup)).id);
    expect(rows2.map((r) => r.action)).toEqual(['update', 'error']);
    expect(rows2[1]!.errors[0]).toMatchObject({ code: 'duplicate_in_file' });
    expect(rows2[1]!.errors[0].message).toContain('Row 2');
  });

  it('needs the actual date, refuses an approved or N/A task, holds a task that waits for a predecessor or is in review, and refuses a gate-locked task (Q81)', async () => {
    const t = await streamTeam(app, db, { B4: 'open', B5: 'locked', B9: 'in_review', B13: 'approved', B10: 'open' });
    await makeTask(db, t.site, 'B7', 'approved');                                    // predecessor of B8 and B9
    t.tasks.B8 = await makeTask(db, t.site, 'B8', 'locked');
    await setCell(db, 'B8', SR, 'entry', { user: [t.entry.user.id] });
    await db.query(`UPDATE task_instances SET lock_reason = 'gate_closed:G3' WHERE id = $1`, [t.tasks.B8]);
    await db.query(`UPDATE task_instances SET is_na = true, na_reason = 'not applicable' WHERE id = $1`, [t.tasks.B10]);
    const buf = await filled(t.entry.api, 'TPL-SITE-CW', [{
      'Site ID': t.site.code,
      'B4 CW Survey Planned': day('2026-02-01'),               // no actual date, none on the task
      'B5 Actual Date': day('2026-02-05'),
      'B8 CW MOS Actual': day('2026-02-06'),
      'B9 Actual Date': day('2026-02-07'),
      'B13 CW PAC Actual': day('2026-02-08'),
      'B10 Actual Date': day('2026-02-09'),
    }]);
    const batch = await upload(t.entry.api, buf);
    const rows = await rowsOf(t.entry.api, batch.id);
    expect(byTask(rows, 'B4')).toMatchObject({ action: 'error' });
    expect(byTask(rows, 'B4').errors[0]).toMatchObject({ code: 'actual_date_required', column: 'B4 CW Survey Actual' });
    expect(byTask(rows, 'B5')).toMatchObject({ action: 'update', decision: 'pending_previous_approval', hold_reason: 'predecessor_open' });
    expect(byTask(rows, 'B5').warnings[0]).toMatchObject({ code: 'held_predecessor' });
    expect(byTask(rows, 'B5').warnings[0].message).toContain('B4');
    expect(byTask(rows, 'B9')).toMatchObject({ action: 'update', decision: 'pending_previous_approval', hold_reason: 'open_submission' });
    expect(byTask(rows, 'B8')).toMatchObject({ action: 'error' });
    expect(byTask(rows, 'B8').errors[0]).toMatchObject({ code: 'gate_locked', column: 'B8 CW MOS Actual' });
    expect(byTask(rows, 'B8').errors[0].message).toContain('G3');
    expect(byTask(rows, 'B13')).toMatchObject({ action: 'error' });
    expect(byTask(rows, 'B13').errors[0]).toMatchObject({ code: 'task_approved' });
    expect(byTask(rows, 'B10')).toMatchObject({ action: 'error' });
    expect(byTask(rows, 'B10').errors[0]).toMatchObject({ code: 'task_not_open' });
    expect(batch.counts).toMatchObject({ held: 2, error: 4, update: 2 });
    // only the held rows and the errors: nothing can be sent
    const sub = await submit(t.entry.api, batch.id, batch.version);
    expect(sub.outcome).toMatchObject({ submitted: 0 });
    expect(sub.outcome.held.map((h: { reason: string }) => h.reason).sort()).toEqual(['open_submission', 'predecessor_open']);
    expect((await taskRow(db, t.tasks.B8!)).state).toBe('locked');
  });

  it('warns, never blocks, about a calculated column that differs, a date before the SLA start (negative) and a date after the SLA limit (late)', async () => {
    const t = await streamTeam(app, db, { B4: 'open' });
    const t2 = await moreSite(db, t, { B4: 'open' });
    await db.query(`UPDATE task_instances SET sla_start_date = '2026-03-01', due_date = '2026-03-10' WHERE id = ANY($1::uuid[])`, [[t.tasks.B4, t2.tasks.B4]]);
    await makeTask(db, t.site, 'B7', 'approved');
    const buf = await filled(t.entry.api, 'TPL-SITE-CW', [
      { 'Site ID': t.site.code, 'B4 CW Survey Actual': day('2026-03-20'), 'B7 CW DN Submitted': day('2026-03-05') },
      { 'Site ID': t2.site.code, 'B4 CW Survey Actual': day('2026-02-20') },
    ]);
    const batch = await upload(t.entry.api, buf);
    const rows = await rowsOf(t.entry.api, batch.id);
    const first = rows.filter((r) => r.site_code === t.site.code);
    const late = byTask(first, 'B4');
    expect(late).toMatchObject({ action: 'update', errors: [] });
    expect(late.warnings.map((w: { code: string }) => w.code)).toEqual(['sla_late']);
    const calc = byTask(first, 'B7');
    expect(calc).toMatchObject({ action: 'unchanged' });
    expect(calc.warnings[0]).toMatchObject({ code: 'calculated_column', column: 'B7 CW DN Submitted' });
    const neg = byTask(rows.filter((r) => r.site_code === t2.site.code), 'B4');
    expect(neg).toMatchObject({ action: 'update', errors: [] });
    expect(neg.warnings.map((w: { code: string }) => w.code)).toEqual(['sla_negative']);
    expect(batch.counts.error).toBe(0);
  });

  it('refuses a file of another stream, an upload from a task of another stream, a retired file and a file without _tpl, with the reason in the System Log', async () => {
    const t = await streamTeam(app, db, { B4: 'open' });
    const cw = await downloadTemplate(t.entry.api, 'TPL-SITE-CW');
    const res = await uploadFile(t.entry.api, cw.buffer, 'x.xlsx', { template_id: 'TPL-SITE-TE' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'template_rejected', reason: 'wrong_template' });
    expect((await logRows('wrong_template'))[0]!.context).toMatchObject({ template_id: 'TPL-SITE-CW', selected: 'TPL-SITE-TE' });
    // the file of the CW stream, sent from a TE task
    const te = await makeTask(db, t.site, 'D5', 'locked');
    const fromTask = await uploadFile(t.entry.api, await fillTemplate(cw.buffer, [{ 'Site ID': t.site.code, 'B4 CW Survey Actual': day('2026-01-10') }]), 'x.xlsx', { task_id: te });
    expect(fromTask.status).toBe(422);
    expect(fromTask.body).toMatchObject({ reason: 'wrong_template' });
    // from a CW task of another site: that site's rows only
    const t2 = await moreSite(db, t, { B4: 'open' });
    const other = await uploadFile(t.entry.api, await fillTemplate(cw.buffer, [{ 'Site ID': t.site.code, 'B4 CW Survey Actual': day('2026-01-10') }]), 'x.xlsx', { task_id: t2.tasks.B4! });
    expect(other.status).toBe(202);
    expect(other.body).toMatchObject({ task_id: t2.tasks.B4, site_id: t2.site.id });
    expect((await rowsOf(t.entry.api, other.body.id))[0]!.errors[0]).toMatchObject({ code: 'not_task_site' });
    // no _tpl sheet and a tampered header row
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Data').addRow(['Site ID', 'B4 CW Survey Actual']);
    const plain = await uploadFile(t.entry.api, Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer), 'plain.xlsx');
    expect(plain.body).toMatchObject({ code: 'template_rejected', reason: 'tpl_missing' });
    const renamed = await fillTemplate(cw.buffer, [], { edit: (b) => { b.getWorksheet('Data')!.getRow(1).getCell(8).value = 'B4 Survey'; } });
    expect((await uploadFile(t.entry.api, renamed)).body).toMatchObject({ reason: 'checksum_mismatch' });
    // an import right is needed first: 403 before anything is read (permission denied)
    expect((await uploadFile(t.approve.api, cw.buffer)).status).toBe(403);
    // a user with import but no edit right on the Site Register gets 422 import_not_allowed
    const viewer = await actor(app, db, { grants: [...G('sites', 'view'), ...G('templates', 'view', 'import')], regions: [SR], modules: null });
    const denied = await uploadFile(viewer.api, await fillTemplate(cw.buffer, [{ 'Site ID': t.site.code, 'B4 CW Survey Actual': day('2026-01-10') }]));
    expect(denied.status).toBe(422);
    expect(denied.body).toMatchObject({ reason: 'import_not_allowed' });
    expect((await logRows('import_not_allowed'))[0]).toBeTruthy();
  });
});

describe('upload: the xlsx guard of every template', () => {
  it('rejects macros, other formats, oversize and too many rows of a stream file, and a stream file with formulas keeps the rest of the rows', async () => {
    const t = await streamTeam(app, db, { B4: 'open' });
    const t2 = await moreSite(db, t, { B4: 'open' });
    const dl = await downloadTemplate(t.entry.api, 'TPL-SITE-CW');
    expect((await uploadFile(t.entry.api, dl.buffer, 'filled.xlsm')).body).toMatchObject({ code: 'template_rejected', reason: 'macros_not_allowed' });
    expect((await uploadFile(t.entry.api, dl.buffer, 'filled.csv')).body).toMatchObject({ reason: 'not_xlsx' });
    expect((await uploadFile(t.entry.api, Buffer.from('PK not really a zip'), 'filled.xlsx')).body).toMatchObject({ reason: 'not_xlsx' });
    expect((await logRows('macros_not_allowed'))[0]).toMatchObject({ source: 'template-check', user_id: t.entry.user.id });
    process.env.PMIS_IMPORT_MAX_BYTES = '4096';
    try {
      const big = await uploadFile(t.entry.api, Buffer.alloc(9000, 1), 'big.xlsx');
      expect(big.status).toBe(413);
      expect(big.body).toMatchObject({ reason: 'size_or_rows_exceeded' });
    } finally {
      delete process.env.PMIS_IMPORT_MAX_BYTES;
    }
    const two = await fillTemplate(dl.buffer, [
      { 'Site ID': t.site.code, 'B4 CW Survey Actual': day('2026-01-10') },
      { 'Site ID': t2.site.code, 'B4 CW Survey Actual': day('2026-01-11') },
    ]);
    process.env.PMIS_IMPORT_MAX_ROWS = '1';
    try {
      expect((await uploadFile(t.entry.api, two)).body).toMatchObject({ reason: 'size_or_rows_exceeded' });
    } finally {
      delete process.env.PMIS_IMPORT_MAX_ROWS;
    }
    // a formula is a cell error of its row; the other row goes on
    const mixed = await fillTemplate(dl.buffer, [
      { 'Site ID': t.site.code, 'B4 CW Survey Actual': { formula: 'TODAY()', result: 1 } as unknown as ExcelJS.CellValue },
      { 'Site ID': t2.site.code, 'B4 CW Survey Actual': day('2026-01-11') },
    ]);
    const rows = await rowsOf(t.entry.api, (await upload(t.entry.api, mixed)).id);
    expect(rows.map((r) => r.action)).toEqual(['error', 'update']);
    expect(rows[0]!.errors[0]).toMatchObject({ code: 'formula_not_allowed', column: 'B4 CW Survey Actual' });
  });
});

describe('submit into the flow, and L2 decisions', () => {
  it('starts, saves and submits each task as the uploader; L2 approves all at once with step-up; the successor opens; the history and the audit say via batch', async () => {
    const t = await streamTeam(app, db, { A2: 'open', A5: 'locked' });
    const buf = await filled(t.entry.api, 'TPL-SITE-DA', [{ 'Site ID': t.site.code, 'A2 Planned Date': day('2026-01-05'), 'A2 Actual Date': day('2026-01-10') }]);
    const batch = await upload(t.entry.api, buf);
    expect(batch.counts).toMatchObject({ update: 1, error: 0 });
    // before the send: nothing happens, and L2 cannot decide a batch that was not sent
    expect((await taskRow(db, t.tasks.A2!)).state).toBe('open');
    expect((await decide(t.approve.api, batch.id, batch.version, { action: 'approve', scope: 'all' })).status).toBe(409);
    // only the uploader sends it
    expect((await t.approve.api.call('post', `/import-batches/${batch.id}/submit`, undefined, { 'If-Match': `"${batch.version}"` })).status).toBe(403);
    expect((await t.entry.api.call('post', `/import-batches/${batch.id}/submit`)).status).toBe(428);
    expect((await t.entry.api.call('post', `/import-batches/${batch.id}/submit`, undefined, { 'If-Match': '"9"' })).status).toBe(412);
    const sent = await submit(t.entry.api, batch.id, batch.version);
    expect(sent.outcome).toMatchObject({ submitted: 1, held: [], failed: [] });
    expect(sent.status).toBe('in_approval');
    expect(sent.current_level).toBe(2);
    const task = await taskRow(db, t.tasks.A2!);
    expect(task).toMatchObject({ state: 'in_approval', actual_date: '2026-01-10', planned_date: '2026-01-05' });
    const rows = await rowsOf(t.entry.api, batch.id);
    const steps = await q<{ action: string; acted_by: string; batch_row_id: string | null; after_state: string }>(db,
      `SELECT action::text AS action, acted_by::text AS acted_by, batch_row_id::text AS batch_row_id, after_state::text AS after_state FROM workflow_steps WHERE task_id = $1 ORDER BY created_at, id`, [t.tasks.A2]);
    expect(steps.map((s) => s.action)).toEqual(['start', 'submit']);
    expect(steps.every((s) => s.batch_row_id === rows[0]!.id && s.acted_by === t.entry.user.id)).toBe(true);
    const aud = await q<{ action: string; via: string | null; batch_row: string | null; actor_id: string }>(db,
      `SELECT action, via, batch_row::text AS batch_row, actor_id::text AS actor_id FROM audit_log WHERE entity_type = 'task' AND entity_id = $1 ORDER BY id`, [t.tasks.A2]);
    expect(aud.map((a) => a.action)).toEqual(['task_start', 'task_entry_update', 'task_submit']);
    expect(aud.every((a) => a.via === 'template' && a.batch_row === rows[0]!.id && a.actor_id === t.entry.user.id)).toBe(true);

    // L2: the holder of the approve cell, with a step-up; the entry holder may not
    expect((await decide(t.entry.api, batch.id, sent.version, { action: 'approve', scope: 'all' })).status).toBe(403);
    const done = await decide(t.approve.api, batch.id, sent.version, { action: 'approve', scope: 'all' });
    expect(done.status).toBe(200);
    expect(done.body.outcome).toMatchObject({ decided: 1, approved: 1, rejected: 0, held: [], failed: [] });
    expect(done.body.status).toBe('approved');
    expect(done.body.counts).toMatchObject({ approved: 1, pending: 0 });
    expect((await taskRow(db, t.tasks.A2!)).state).toBe('approved');
    expect((await taskRow(db, t.tasks.A5!)).state).toBe('open');                     // the successor is unlocked by the normal engine
    const row = (await rowsOf(t.entry.api, batch.id))[0]!;
    expect(row).toMatchObject({ decision: 'approved' });
    const last = await q<{ action: string; batch_row_id: string | null; acted_by: string }>(db,
      `SELECT action::text AS action, batch_row_id::text AS batch_row_id, acted_by::text AS acted_by FROM workflow_steps WHERE task_id = $1 AND action = 'approve'`, [t.tasks.A2]);
    expect(last).toEqual([{ action: 'approve', batch_row_id: row.id, acted_by: t.approve.user.id }]);
    const note = await q(db, `SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'import_batch'`, [t.entry.user.id]);
    expect(note).toHaveLength(1);
    // the audit of the batch: create, submit, approve
    const ba = await q<{ action: string }>(db, `SELECT action FROM audit_log WHERE entity_type = 'import_batch' AND entity_id = $1 ORDER BY id`, [batch.id]);
    expect(ba.map((x) => x.action)).toEqual(['import_batch_create', 'import_batch_submit', 'import_batch_approve']);
  });

  it('approves row by row, returns a row with a note to L1, and a return without a note is refused', async () => {
    const t = await streamTeam(app, db, { A2: 'open' });
    const t2 = await moreSite(db, t, { A2: 'open' });
    const buf = await filled(t.entry.api, 'TPL-SITE-DA', [
      { 'Site ID': t.site.code, 'A2 Actual Date': day('2026-01-10') },
      { 'Site ID': t2.site.code, 'A2 Actual Date': day('2026-01-11') },
    ]);
    const batch = await upload(t.entry.api, buf);
    const sent = await submit(t.entry.api, batch.id, batch.version);
    expect(sent.outcome.submitted).toBe(2);
    const rows = await rowsOf(t.entry.api, batch.id);
    const r1 = rows.find((r) => r.site_code === t.site.code)!;
    const r2 = rows.find((r) => r.site_code === t2.site.code)!;
    expect((await decide(t.approve.api, batch.id, sent.version, { action: 'reject', scope: 'all' })).status).toBe(422);
    const one = await decide(t.approve.api, batch.id, sent.version, { action: 'approve', scope: 'rows', rows: [{ row_id: r1.id, decision: 'approved' }] });
    expect(one.status).toBe(200);
    expect(one.body.outcome).toMatchObject({ decided: 1, approved: 1 });
    expect(one.body.status).toBe('partially_approved');
    expect((await taskRow(db, t.tasks.A2!)).state).toBe('approved');
    expect((await taskRow(db, t2.tasks.A2!)).state).toBe('in_approval');
    const back = await decide(t.approve.api, batch.id, one.body.version, { action: 'reject', scope: 'rows', rows: [{ row_id: r2.id, decision: 'rejected', note: 'wrong date' }] });
    expect(back.status).toBe(200);
    expect(back.body.outcome).toMatchObject({ decided: 1, rejected: 1 });
    expect(back.body.status).toBe('approved');                                         // every row decided, at least one approved
    const returned = await taskRow(db, t2.tasks.A2!);
    expect(returned.state).toBe('entry');                                              // back at L1 Data Entry
    const rn = await q<{ last_return_note: string; return_count: number }>(db, `SELECT last_return_note, return_count FROM task_instances WHERE id = $1`, [t2.tasks.A2]);
    expect(rn[0]).toMatchObject({ last_return_note: 'wrong date', return_count: 1 });
    const after = await rowsOf(t.entry.api, batch.id);
    expect(after.find((r) => r.id === r2.id)).toMatchObject({ decision: 'rejected', note: 'wrong date' });
    expect(after.find((r) => r.id === r1.id)).toMatchObject({ decision: 'approved' });
    const cm = await q<{ body: string; is_rejection_note: boolean }>(db, `SELECT body, is_rejection_note FROM comments WHERE task_id = $1`, [t2.tasks.A2]);
    expect(cm).toEqual([{ body: 'wrong date', is_rejection_note: true }]);
  });

  it('holds a row until its predecessor is approved: approve-all lists it and leaves it, and a second send releases it', async () => {
    const t = await streamTeam(app, db, { A2: 'open', A5: 'locked' });
    const buf = await filled(t.entry.api, 'TPL-SITE-DA', [{ 'Site ID': t.site.code, 'A2 Actual Date': day('2026-01-10'), 'A5 Actual Date': day('2026-01-12') }]);
    const batch = await upload(t.entry.api, buf);
    const rows = await rowsOf(t.entry.api, batch.id);
    expect(byTask(rows, 'A5')).toMatchObject({ decision: 'pending_previous_approval', hold_reason: 'predecessor_open' });
    expect(batch.counts).toMatchObject({ update: 2, held: 1 });
    const sent = await submit(t.entry.api, batch.id, batch.version);
    expect(sent.outcome.submitted).toBe(1);
    expect(sent.outcome.held).toEqual([expect.objectContaining({ row_no: 2, reason: 'predecessor_open', key: `${t.site.code} / A5` })]);
    // the held row cannot be returned by a stranger; "approve all" leaves it
    const stranger = await actor(app, db, { level: 'approve', grants: [...G('sites', 'view', 'approve'), ...G('templates', 'view')], regions: [SR], modules: null });
    const nope = await decide(stranger.api, batch.id, sent.version, { action: 'reject', scope: 'rows', rows: [{ row_id: byTask(rows, 'A5').id, decision: 'rejected', note: 'no' }] });
    expect(nope.status).toBe(403);
    const all = await decide(t.approve.api, batch.id, sent.version, { action: 'approve', scope: 'all' });
    expect(all.body.outcome).toMatchObject({ decided: 1, approved: 1 });
    expect(all.body.outcome.held).toHaveLength(1);
    expect(all.body.status).toBe('partially_approved');
    expect((await taskRow(db, t.tasks.A5!)).state).toBe('open');                       // its predecessor is approved now
    const again = await submit(t.entry.api, batch.id, all.body.version);
    expect(again.outcome).toMatchObject({ submitted: 1, held: [] });
    expect((await taskRow(db, t.tasks.A5!))).toMatchObject({ state: 'in_approval', actual_date: '2026-01-12' });
    const fin = await decide(t.approve.api, batch.id, again.version, { action: 'approve', scope: 'all' });
    expect(fin.body.outcome).toMatchObject({ approved: 1 });
    expect(fin.body.status).toBe('approved');
    expect((await taskRow(db, t.tasks.A5!)).state).toBe('approved');
  });

  it('holds a row for a task that is already in review, and a discard closes an unsent batch', async () => {
    const t = await streamTeam(app, db, { A2: 'open' });
    const first = await upload(t.entry.api, await filled(t.entry.api, 'TPL-SITE-DA', [{ 'Site ID': t.site.code, 'A2 Actual Date': day('2026-01-10') }]));
    const sent = await submit(t.entry.api, first.id, first.version);
    expect(sent.outcome.submitted).toBe(1);
    const second = await upload(t.entry.api, await filled(t.entry.api, 'TPL-SITE-DA', [{ 'Site ID': t.site.code, 'A2 Actual Date': day('2026-01-11') }]));
    expect(byTask(await rowsOf(t.entry.api, second.id), 'A2')).toMatchObject({ decision: 'pending_previous_approval', hold_reason: 'open_submission' });
    expect((await decide(t.approve.api, second.id, second.version, { action: 'discard', scope: 'all' })).status).toBe(403);   // only the uploader or an admin
    const d = await decide(t.entry.api, second.id, second.version, { action: 'discard', scope: 'all', note: 'wrong file' });
    expect(d.status).toBe(200);
    expect(d.body.status).toBe('discarded');
    expect((await submit(t.entry.api, second.id, d.body.version, 409)).code).toBe('invalid_transition');
    expect((await taskRow(db, t.tasks.A2!)).actual_date).toBe('2026-01-10');
  });

  it('a self-approval needs a step-up: without it nothing is created, with it the task is approved at once and flagged', async () => {
    const t = await streamTeam(app, db, { A2: 'open' }, { sameUser: true, stepUp: false });
    const batch = await upload(t.entry.api, await filled(t.entry.api, 'TPL-SITE-DA', [{ 'Site ID': t.site.code, 'A2 Actual Date': day('2026-01-10') }]));
    const early = await t.entry.api.call('post', `/import-batches/${batch.id}/submit`, undefined, { 'If-Match': `"${batch.version}"` });
    expect(early.status).toBe(401);
    expect(early.body).toMatchObject({ code: 'step_up_required' });
    expect((await taskRow(db, t.tasks.A2!)).state).toBe('open');
    expect((await t.entry.api.call('get', `/import-batches/${batch.id}`)).body.status).toBe('validated');
    expect((await t.entry.api.stepUp(t.entry.user.password)).status).toBe(200);
    const sent = await submit(t.entry.api, batch.id, batch.version);
    expect(sent.outcome).toMatchObject({ submitted: 1 });
    expect(sent.status).toBe('approved');
    expect((await taskRow(db, t.tasks.A2!)).state).toBe('approved');
    expect((await rowsOf(t.entry.api, batch.id))[0]).toMatchObject({ decision: 'approved' });
    const sa = await q<{ self_approval: boolean }>(db, `SELECT self_approval FROM task_instances WHERE id = $1`, [t.tasks.A2]);
    expect(sa[0]!.self_approval).toBe(true);
  });

  it('keeps the batch away from people without the Site Register, and a row the task refuses at the send becomes an error and keeps nothing', async () => {
    const t = await streamTeam(app, db, { B4: 'open' });
    const batch = await upload(t.entry.api, await filled(t.entry.api, 'TPL-SITE-CW', [{ 'Site ID': t.site.code, 'B4 CW Survey Actual': day('2026-01-10') }]));
    const stranger = await actor(app, db, { grants: G('templates', 'view'), regions: [SR], modules: null });
    expect((await stranger.api.call('get', `/import-batches/${batch.id}`)).status).toBe(404);
    expect((await stranger.api.call('get', `/import-batches/${batch.id}/rows`)).status).toBe(404);
    const viewer = await actor(app, db, { grants: [...G('sites', 'view'), ...G('templates', 'view')], regions: [SR], modules: null });
    expect((await viewer.api.call('get', `/import-batches/${batch.id}`)).status).toBe(200);          // a Site Register reader sees the batches of the streams
    const list = await viewer.api.call('get', '/import-batches?stream=CW');
    expect(list.body.items.map((i: { id: string }) => i.id)).toContain(batch.id);
    expect((await decide(viewer.api, batch.id, batch.version, { action: 'approve', scope: 'all' })).status).toBe(403);

    // the task changes between the preview and the send: it is locked by a closed gate now
    await db.query(`UPDATE task_instances SET state = 'locked', lock_reason = 'gate_closed:G2' WHERE id = $1`, [t.tasks.B4]);
    const sent = await submit(t.entry.api, batch.id, batch.version);
    expect(sent.outcome.submitted).toBe(0);
    expect(sent.outcome.failed).toEqual([expect.objectContaining({ code: 'gate_locked' })]);
    const row = (await rowsOf(t.entry.api, batch.id))[0]!;
    expect(row).toMatchObject({ action: 'error' });
    expect(row.errors[0]).toMatchObject({ code: 'gate_locked' });
    expect((await taskRow(db, t.tasks.B4!)).actual_date).toBeNull();
  });
});

describe('template versions', () => {
  beforeEach(async () => { await db.query('SELECT pg_advisory_lock(770101)'); });
  afterEach(async () => { await db.query('SELECT pg_advisory_unlock(770101)'); });

  it('issues the next version when a task field changes, refuses the old file with both versions in the message, and audits the new version', async () => {
    const t = await streamTeam(app, db, { B4: 'open' });
    const admin = await plainAdmin(app, db);
    const v0 = (await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-SITE-CW'`))[0]!.v;
    const m0 = (await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-MASTER'`))[0]!.v;
    const te0 = (await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-SITE-TE'`))[0]!.v;
    const old = await downloadTemplate(t.entry.api, 'TPL-SITE-CW');
    const oldFile = await fillTemplate(old.buffer, [{ 'Site ID': t.site.code, 'B4 CW Survey Actual': day('2026-01-10') }]);
    await db.query(`UPDATE template_task_fields SET label = 'CW Survey Actual Date' WHERE task_code = 'B4' AND field_key = 'actual_date'`);
    try {
      const list = (await admin.api.call('get', '/templates')).body.items as { template_id: string; current_version: number; versions: { version: number }[] }[];
      const cw = list.find((i) => i.template_id === 'TPL-SITE-CW')!;
      expect(cw.current_version).toBe(v0 + 1);
      expect(cw.versions.map((v) => v.version)).toEqual([v0 + 1, v0]);
      expect(list.find((i) => i.template_id === 'TPL-MASTER')!.current_version).toBe(m0);   // the Master header text comes from the Master, not from the label: same columns
      expect(list.find((i) => i.template_id === 'TPL-SITE-TE')!.current_version).toBe(te0);   // another stream is not touched
      const res = await uploadFile(t.entry.api, oldFile);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'template_rejected', reason: 'outdated_version' });
      expect(res.body.detail).toContain(`version ${v0} of TPL-SITE-CW`);
      expect(res.body.detail).toContain(`current version is ${v0 + 1}`);
      expect((await logRows('outdated_version'))[0]!.context).toMatchObject({ template_id: 'TPL-SITE-CW', version: v0, current_version: v0 + 1 });
      const fresh = await downloadTemplate(t.entry.api, 'TPL-SITE-CW');
      const wb = await load(fresh.buffer);
      expect(kvOf(wb).get('version')).toBe(v0 + 1);
      expect(headersOf(wb.getWorksheet('Data')!)).toContain('B4 CW Survey Actual Date');
      expect(headersOf(wb.getWorksheet('Data')!)).not.toContain('B4 CW Survey Actual');
      const ok = await uploadFile(t.entry.api, await fillTemplate(fresh.buffer, [{ 'Site ID': t.site.code, 'B4 CW Survey Actual Date': day('2026-01-10') }]));
      expect(ok.status).toBe(202);
      const states = await q<{ version: number; status: string }>(db, `SELECT version, status FROM templates WHERE template_id = 'TPL-SITE-CW' ORDER BY version DESC LIMIT 2`);
      expect(states).toEqual([{ version: v0 + 1, status: 'active' }, { version: v0, status: 'retired' }]);
      const au = await q(db, `SELECT 1 FROM audit_log WHERE action = 'template_version_issued' AND entity_id = 'TPL-SITE-CW' AND (after ->> 'version')::int = $1`, [v0 + 1]);
      expect(au).toHaveLength(1);
      // an unchanged field set issues no new version
      await db.query('SELECT tpl_sync_all()');
      expect((await q<{ n: string }>(db, `SELECT count(*)::text AS n FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-SITE-CW'`))[0]!.n).toBe(String(v0 + 1));
    } finally {
      await db.query(`UPDATE template_task_fields SET label = 'CW Survey Actual' WHERE task_code = 'B4' AND field_key = 'actual_date'`);
    }
    expect((await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-SITE-CW'`))[0]!.v).toBe(v0 + 2);
  });

  it('issues a new version of the stream template and of TPL-MASTER when a task is added to a stage of the stream', async () => {
    const t = await streamTeam(app, db, {});
    expect(t.region).toBe(SR);
    const cw0 = (await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-SITE-CW'`))[0]!.v;
    const m0 = (await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-MASTER'`))[0]!.v;
    const stage = await q<{ id: string; workflow_id: string }>(db, `SELECT sd.id::text AS id, sd.workflow_id::text AS workflow_id FROM stage_definitions sd JOIN workflow_definitions w ON w.id = sd.workflow_id AND w.version = 1 WHERE sd.code = 'MS3'`);
    const ins = await db.query(`INSERT INTO task_definitions (workflow_id, code, stage_id, sort_order, name_en) VALUES ($1, 'ZX1', $2, 35, 'Extra CW check') RETURNING id`, [stage[0]!.workflow_id, stage[0]!.id]);
    try {
      expect((await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-SITE-CW'`))[0]!.v).toBe(cw0 + 1);
      expect((await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-MASTER'`))[0]!.v).toBe(m0);   // the Master sheet is the Master: no new column
      const dl = await downloadTemplate(t.entry.api, 'TPL-SITE-CW');
      expect(headersOf((await load(dl.buffer)).getWorksheet('Data')!)).toEqual(expect.arrayContaining(['ZX1 Planned Date', 'ZX1 Actual Date']));
    } finally {
      await db.query('DELETE FROM task_definitions WHERE id = $1', [ins.rows[0].id]);
    }
    expect((await q<{ v: number }>(db, `SELECT current_version AS v FROM template_definitions WHERE template_id = 'TPL-SITE-CW'`))[0]!.v).toBe(cw0 + 2);
  });
});
