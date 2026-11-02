import { createHash } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { startApp, superDb } from './helpers';
import { GECOL, G, Team, approveAll, createRec, post, recPath } from './reg-helpers';
import { CellMap, day, downloadTemplate, fillTemplate, getBinary, load, tplTeam, uploadFile } from './tpl-helpers';
import { actor, addAssignment, makeSite, plainAdmin } from './wf-helpers';

/**
 * Migration 0037: approved-template entry. Registers: GECOL (one record per site, key = Site ID), Procurement and Meetings for the version rule.
 * The suites that rewrite register cells and fields share one advisory lock (770101), so a field added here is seen by nobody else.
 * Dates are fixed past dates; nothing depends on the weekday or the collation.
 */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
beforeEach(async () => {
  await db.query('SELECT pg_advisory_lock(770101)');
});
afterEach(async () => {
  await db.query('SELECT pg_advisory_unlock(770101)');
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const R = 5;
const OUT = 3; // a region none of the callers holds
const H = { site: 'Site ID', pr: 'GECOL PR No.', req: 'GECOL Request Date', remark: 'Remark', recordId: 'Record ID', survey: 'Survey Date', contractor: 'GECOL Contractor' } as const;

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const rowsOf = async (api: Team['entry']['api'], id: string, query = ''): Promise<Record<string, any>[]> => {
  const res = await api.call('get', `/import-batches/${id}/rows${query}`);
  expect(res.status).toBe(200);
  return res.body.items;
};
const logRows = (reason: string): Promise<{ message: string; source: string; context: Record<string, unknown>; user_id: string }[]> =>
  q(db, `SELECT message, source, context, user_id FROM system_log WHERE source = 'template-check' AND context ->> 'reason' = $1 ORDER BY id DESC LIMIT 5`, [reason]);

async function approved(t: Team, site: { id: string }, extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const c = await createRec(t, { ...GECOL, ...extra }, { site_id: site.id });
  return approveAll(t, c.id, c.version);
}

describe('catalogue and download', () => {
  it('lists the templates of the registers the caller may use and downloads the current version with a hidden _tpl sheet', async () => {
    const t = await tplTeam(app, db, 'gecol', 'gecol', R);
    const list = await t.entry.api.call('get', '/templates');
    expect(list.status).toBe(200);
    const ids = list.body.items.map((i: { template_id: string }) => i.template_id);
    expect(ids).toEqual(['TPL-GECOL']);                                    // only the register this person holds
    const gecol = list.body.items[0];
    expect(gecol).toMatchObject({ kind: 'data_import', register_key: 'gecol', is_active: true });
    expect(gecol.current_version).toBeGreaterThanOrEqual(1);
    expect(gecol.versions[0]).toMatchObject({ version: gecol.current_version });

    const dl = await downloadTemplate(t.entry.api, 'TPL-GECOL');
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="TPL-GECOL_v\d+_\d{4}-\d{2}-\d{2}\.xlsx"$/);
    const wb = await load(dl.buffer);
    const tpl = wb.getWorksheet('_tpl')!;
    expect(tpl.state).toBe('veryHidden');
    const kv = new Map<string, unknown>();
    tpl.eachRow((r) => kv.set(String(r.getCell(1).value), r.getCell(2).value));
    expect(kv.get('template_id')).toBe('TPL-GECOL');
    expect(Number(kv.get('version'))).toBe(gecol.current_version);
    expect(kv.get('register_key')).toBe('gecol');
    expect(kv.get('prefilled')).toBe('no');
    // the checksum of the header row is the one of the issued version
    const data = wb.getWorksheet('Data')!;
    const headers: string[] = [];
    for (let c = 1; c <= data.getRow(1).cellCount; c++) headers.push(String(data.getRow(1).getCell(c).value));
    expect(sha(headers.join('\u001f'))).toBe(kv.get('header_checksum'));
    expect(headers[0]).toBe('Site ID');
    expect(headers.at(-1)).toBe('Record ID');
    expect(headers).toContain('GECOL PR No.');
    // locked headers (the sheet is protected), a hidden list sheet, validation for dates, an instructions sheet
    expect((data as unknown as { sheetProtection: unknown }).sheetProtection).toBeTruthy();
    expect(wb.getWorksheet('_lists')!.state).toBe('veryHidden');
    expect(wb.getWorksheet('Instructions')!.state).toBe('visible');
    const model = (data as unknown as { dataValidations: { model: Record<string, { type: string }> } }).dataValidations.model;
    expect(Object.values(model).some((v) => v.type === 'date')).toBe(true);
    // every download is audited
    const au = await q<{ after: { version: number; prefill: boolean } }>(db, `SELECT after FROM audit_log WHERE action = 'template_download' AND entity_id = 'TPL-GECOL' AND actor_id = $1`, [t.entry.user.id]);
    expect(au).toHaveLength(1);
    expect(au[0]!.after).toMatchObject({ version: gecol.current_version, prefill: false });
  });

  it('keeps the list fields as drop-downs and refuses a caller without the right (permission denied)', async () => {
    const t = await tplTeam(app, db, 'procurement', 'procurement', R);
    const dl = await downloadTemplate(t.entry.api, 'TPL-PO');
    expect(dl.status).toBe(200);
    const wb = await load(dl.buffer);
    const lists = wb.getWorksheet('_lists')!;
    const heads: string[] = [];
    lists.getRow(1).eachCell((c) => heads.push(String(c.value)));
    expect(heads).toEqual(expect.arrayContaining(['scope', 'delivery', 'record_type']));
    const col = heads.indexOf('delivery') + 1;
    const vals: string[] = [];
    lists.getColumn(col).eachCell({ includeEmpty: false }, (c, r) => { if (r > 1 && c.value !== null) vals.push(String(c.value)); });
    expect(vals).toEqual(['Outsourced', 'In-House', 'TE Vendor']);

    // no download right on templates: 403; no module right: 403; not an approved template: 404
    const noRight = await actor(app, db, { grants: [...G('procurement', 'view'), ...G('templates', 'view')], regions: [R], modules: null });
    expect((await downloadTemplate(noRight.api, 'TPL-PO')).status).toBe(403);
    const noModule = await actor(app, db, { grants: G('templates', 'view', 'download_documents'), regions: [R], modules: null });
    const denied = await downloadTemplate(noModule.api, 'TPL-PO');
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'module_forbidden' });
    expect((await downloadTemplate(t.entry.api, 'TPL-NOPE')).status).toBe(404);
    expect((await t.entry.api.raw('get', '/templates/TPL-PO/download')).status).toBe(200);
    expect((await noRight.api.call('get', '/templates')).body.items.map((i: { template_id: string }) => i.template_id)).toEqual(['TPL-PO']);
  });

  it('pre-fills the records in force, only inside the caller regions, and for one task site', async () => {
    const t = await tplTeam(app, db, 'gecol', 'gecol', R);
    const s1 = t.site;
    const s2 = await makeSite(db, R, { prefix: 'TPL' });
    await db.query(`UPDATE sites SET scope_gecol_power = 'yes' WHERE id = $1`, [s2.id]);
    await approved(t, s1, { remark: 'first' });
    await approved({ ...t, site: s2 }, s2, { pr_no: 'GP-2' });
    // a record of a region the caller does not hold (written as the superuser)
    const far = await makeSite(db, OUT, { prefix: 'FAR' });
    await db.query(`INSERT INTO register_records (entity_id, register_key, site_id, region_id, state, is_current, levels_required, data) VALUES (gen_random_uuid(), 'gecol', $1, $2, 'approved', true, 2, $3)`,
      [far.id, OUT, JSON.stringify({ pr_no: 'GP-FAR', request_date: '2026-01-05' })]);

    const dl = await downloadTemplate(t.entry.api, 'TPL-GECOL', '?prefill=true');
    expect(dl.status).toBe(200);
    const ws = (await load(dl.buffer)).getWorksheet('Data')!;
    const codes: string[] = [];
    ws.eachRow((r, n) => { if (n > 1 && r.getCell(1).value) codes.push(String(r.getCell(1).value)); });
    expect(codes).toContain(s1.code);
    expect(codes).toContain(s2.code);
    expect(codes).not.toContain(far.code);                                  // filtered to the caller's regions
    const row = [...Array(ws.rowCount).keys()].map((i) => i + 1).find((n) => ws.getRow(n).getCell(1).value === s1.code)!;
    expect(ws.getRow(row).getCell(2).value).toBe('GP-1');
    expect(ws.getRow(row).getCell(3).value).toEqual(day('2026-01-05'));
    expect(String(ws.getRow(row).getCell(17).value)).toMatch(/^[0-9a-f-]{36}$/);        // Record ID

    const one = await downloadTemplate(t.entry.api, 'TPL-GECOL', `?site_ids=${s2.id}`);
    const ws1 = (await load(one.buffer)).getWorksheet('Data')!;
    const only: string[] = [];
    ws1.eachRow((r, n) => { if (n > 1 && r.getCell(1).value) only.push(String(r.getCell(1).value)); });
    expect(only).toEqual([s2.code]);
    const kv = (await load(one.buffer)).getWorksheet('_tpl')!;
    expect(kv.getRow(12).getCell(2).value).toBe('yes');
    const au = await q<{ after: { prefill: boolean; rows: number } }>(db, `SELECT after FROM audit_log WHERE action = 'template_download' AND actor_id = $1 ORDER BY id`, [t.entry.user.id]);
    expect(au.map((a) => a.after.rows)).toEqual([2, 1]);
  });
});

describe('upload: rejections are logged and make no batch', () => {
  it('rejects a file without a _tpl sheet, with the reason in the System Log, and creates no batch', async () => {
    const t = await tplTeam(app, db, 'gecol', 'gecol', R);
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Data').addRow(['Site ID', 'GECOL PR No.']);
    const before = await q<{ n: string }>(db, 'SELECT count(*)::text AS n FROM import_batches WHERE uploaded_by = $1', [t.entry.user.id]);
    const res = await uploadFile(t.entry.api, Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer), 'plain.xlsx');
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'template_rejected', reason: 'tpl_missing' });
    const log = await logRows('tpl_missing');
    expect(log[0]).toMatchObject({ source: 'template-check', user_id: t.entry.user.id });
    expect(log[0]!.message).toContain('tpl_missing');
    expect(log[0]!.context).toMatchObject({ file_name: 'plain.xlsx' });
    const after = await q<{ n: string }>(db, 'SELECT count(*)::text AS n FROM import_batches WHERE uploaded_by = $1', [t.entry.user.id]);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('rejects a changed header row and a forged _tpl (checksum), and a file of another template than the selected one', async () => {
    const t = await tplTeam(app, db, 'gecol', 'gecol', R);
    const dl = await downloadTemplate(t.entry.api, 'TPL-GECOL');
    // tampered header
    const renamed = await fillTemplate(dl.buffer, [], { edit: (wb) => { wb.getWorksheet('Data')!.getRow(1).getCell(2).value = 'GECOL PR Number'; } });
    let res = await uploadFile(t.entry.api, renamed);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'template_rejected', reason: 'checksum_mismatch' });
    expect((await logRows('checksum_mismatch'))[0]!.context).toMatchObject({ template_id: 'TPL-GECOL' });
    // an extra column to the right
    const wider = await fillTemplate(dl.buffer, [], { edit: (wb) => { wb.getWorksheet('Data')!.getRow(1).getCell(40).value = 'Extra'; } });
    expect((await uploadFile(t.entry.api, wider)).body).toMatchObject({ reason: 'checksum_mismatch' });
    // the headers are right but the _tpl checksum was edited
    const forged = await fillTemplate(dl.buffer, [], { edit: (wb) => { wb.getWorksheet('_tpl')!.getRow(6).getCell(2).value = 'f'.repeat(64); } });
    expect((await uploadFile(t.entry.api, forged)).body).toMatchObject({ reason: 'checksum_mismatch' });
    // a _tpl that names another template: the headers do not match it, and the selected template is checked first
    const other = await fillTemplate(dl.buffer, [], { edit: (wb) => { wb.getWorksheet('_tpl')!.getRow(1).getCell(2).value = 'TPL-HLC'; } });
    res = await uploadFile(t.entry.api, other, 'x.xlsx', { template_id: 'TPL-GECOL' });
    expect(res.body).toMatchObject({ code: 'template_rejected', reason: 'wrong_template' });
    res = await uploadFile(t.entry.api, other);
    expect(res.body).toMatchObject({ reason: 'checksum_mismatch' });
    // unknown template id and an invalid _tpl
    const unknown = await fillTemplate(dl.buffer, [], { edit: (wb) => { wb.getWorksheet('_tpl')!.getRow(1).getCell(2).value = 'TPL-NOPE'; } });
    expect((await uploadFile(t.entry.api, unknown)).body).toMatchObject({ reason: 'template_unknown_or_inactive' });
    const junk = await fillTemplate(dl.buffer, [], { edit: (wb) => { wb.getWorksheet('_tpl')!.getRow(2).getCell(2).value = 'two'; } });
    expect((await uploadFile(t.entry.api, junk)).body).toMatchObject({ reason: 'tpl_invalid' });
    const inactive = await db.query(`UPDATE template_definitions SET is_active = false WHERE template_id = 'TPL-GECOL'`);
    expect(inactive.rowCount).toBe(1);
    try {
      expect((await uploadFile(t.entry.api, dl.buffer)).body).toMatchObject({ reason: 'template_unknown_or_inactive' });
      expect((await downloadTemplate(t.entry.api, 'TPL-GECOL')).status).toBe(404);
    } finally {
      await db.query(`UPDATE template_definitions SET is_active = true WHERE template_id = 'TPL-GECOL'`);
    }
  });

  it('rejects macros, other formats, text files, oversize files and formulas', async () => {
    const t = await tplTeam(app, db, 'gecol', 'gecol', R);
    const dl = await downloadTemplate(t.entry.api, 'TPL-GECOL');
    expect((await uploadFile(t.entry.api, dl.buffer, 'filled.xlsm')).body).toMatchObject({ code: 'template_rejected', reason: 'macros_not_allowed' });
    expect((await uploadFile(t.entry.api, dl.buffer, 'filled.xlsb')).body).toMatchObject({ reason: 'macros_not_allowed' });
    expect((await uploadFile(t.entry.api, dl.buffer, 'filled.csv')).body).toMatchObject({ reason: 'not_xlsx' });
    expect((await uploadFile(t.entry.api, Buffer.from('PK not really a zip'), 'filled.xlsx')).body).toMatchObject({ reason: 'not_xlsx' });
    expect((await uploadFile(t.entry.api, Buffer.from('a,b\n1,2\n'), 'filled.xlsx')).body).toMatchObject({ reason: 'not_xlsx' });
    // a workbook that carries a VBA project, saved under a plain name: the package is refused
    const wb = await load(dl.buffer);
    const withMacro = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const marked = await addZipEntry(withMacro, 'xl/vbaProject.bin', Buffer.from('MZ'));
    expect((await uploadFile(t.entry.api, marked, 'plain.xlsx')).body).toMatchObject({ reason: 'macros_not_allowed' });
    // oversize: 413 and a log row
    process.env.PMIS_IMPORT_MAX_BYTES = '4096';
    try {
      const big = await uploadFile(t.entry.api, Buffer.alloc(9000, 1), 'big.xlsx');
      expect(big.status).toBe(413);
      expect(big.body).toMatchObject({ reason: 'size_or_rows_exceeded' });
      expect((await logRows('size_or_rows_exceeded'))[0]).toBeTruthy();
    } finally {
      delete process.env.PMIS_IMPORT_MAX_BYTES;
    }
    // too many rows
    process.env.PMIS_IMPORT_MAX_ROWS = '2';
    try {
      const rows: CellMap[] = [1, 2, 3].map((i) => ({ [H.site]: `ZZ-${i}`, [H.pr]: `P${i}` }));
      const three = await fillTemplate(dl.buffer, rows);
      expect((await uploadFile(t.entry.api, three)).body).toMatchObject({ reason: 'size_or_rows_exceeded' });
    } finally {
      delete process.env.PMIS_IMPORT_MAX_ROWS;
    }
    // a formula is a cell error of its row; the rest of the file goes on
    const site = await makeSite(db, R, { prefix: 'TPL' });
    await db.query(`UPDATE sites SET scope_gecol_power = 'yes' WHERE id = $1`, [site.id]);
    const f = await fillTemplate(dl.buffer, [{ [H.site]: site.code, [H.pr]: { formula: '1+1', result: 2 } as unknown as ExcelJS.CellValue, [H.req]: day('2026-01-05') }]);
    const res = await uploadFile(t.entry.api, f);
    expect(res.status).toBe(202);
    const rows = await rowsOf(t.entry.api, res.body.id);
    expect(rows[0]).toMatchObject({ action: 'error' });
    expect(rows[0]!.errors[0]).toMatchObject({ code: 'formula_not_allowed', column: H.pr });
    // no file, and no import right (permission denied)
    expect((await t.entry.api.raw('post', '/import-batches').set('X-CSRF-Token', t.entry.api.csrf!)).status).toBe(422);
    expect((await uploadFile(t.review.api, dl.buffer)).status).toBe(403);
  });

  it('rejects a file of an older version with the current version in the message, and the System Log keeps it', async () => {
    const admin = await plainAdmin(app, db);
    const before = await admin.api.call('get', '/templates');
    const mtg = before.body.items.find((i: { template_id: string }) => i.template_id === 'TPL-MTG');
    const v0 = mtg.current_version as number;
    const dl = await downloadTemplate(admin.api, 'TPL-MTG');
    expect(dl.status).toBe(200);
    // an admin adds a custom field that appears in templates: the next version is issued by the database
    const f = await db.query(`INSERT INTO field_definitions (entity_type, code, label_en, data_type, in_templates, is_active) VALUES ('meeting', 'tpl_probe_x', 'Probe field', 'text', true, true) RETURNING id`);
    try {
      const after = await admin.api.call('get', '/templates');
      expect(after.body.items.find((i: { template_id: string }) => i.template_id === 'TPL-MTG').current_version).toBe(v0 + 1);
      const res = await uploadFile(admin.api, dl.buffer);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'template_rejected', reason: 'outdated_version' });
      expect(res.body.detail).toContain(`version ${v0} of TPL-MTG`);
      expect(res.body.detail).toContain(`current version is ${v0 + 1}`);
      expect((await logRows('outdated_version'))[0]!.context).toMatchObject({ template_id: 'TPL-MTG', version: v0, current_version: v0 + 1 });
      // the new download carries the new column and the new version; the old version is retired
      const fresh = await downloadTemplate(admin.api, 'TPL-MTG');
      const wb = await load(fresh.buffer);
      expect(wb.getWorksheet('_tpl')!.getRow(2).getCell(2).value).toBe(v0 + 1);
      expect(wb.getWorksheet('Data')!.getRow(1).values).toContain('Probe field');
      const states = await q<{ version: number; status: string }>(db, `SELECT version, status FROM templates WHERE template_id = 'TPL-MTG' ORDER BY version DESC LIMIT 2`);
      expect(states).toEqual([{ version: v0 + 1, status: 'active' }, { version: v0, status: 'retired' }]);
      // a file of the new version passes the template checks (it only has no rows)
      const empty = await uploadFile(admin.api, fresh.buffer);
      expect(empty.status).toBe(422);
      expect(empty.body).toMatchObject({ code: 'validation_failed' });
      // an unchanged field set issues no new version
      await db.query('SELECT tpl_sync_all()');
      expect((await q<{ n: string }>(db, `SELECT count(*)::text AS n FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-MTG'`))[0]!.n).toBe(String(v0 + 1));
    } finally {
      await db.query(`UPDATE field_definitions SET is_active = false WHERE id = $1`, [f.rows[0].id]);
    }
    // deactivating the field changed the set again: version v0 + 2, with the same columns as v0 but a new number
    const last = await admin.api.call('get', '/templates');
    expect(last.body.items.find((i: { template_id: string }) => i.template_id === 'TPL-MTG').current_version).toBe(v0 + 2);
    const au = await q(db, `SELECT 1 FROM audit_log WHERE action = 'template_version_issued' AND entity_id = 'TPL-MTG' AND (after ->> 'version')::int = $1`, [v0 + 1]);
    expect(au).toHaveLength(1);
  });
});

describe('upload: staging, classification and the preview', () => {
  it('classifies create, update, unchanged and invalid rows, with the reasons per cell and the diff per field', async () => {
    const t = await tplTeam(app, db, 'gecol', 'gecol', R);
    const s1 = t.site;
    const s2 = await makeSite(db, R, { prefix: 'TPL' });
    const s3 = await makeSite(db, R, { prefix: 'TPL' });
    const s4 = await makeSite(db, R, { prefix: 'TPL' });
    for (const s of [s2, s3, s4]) await db.query(`UPDATE sites SET scope_gecol_power = 'yes' WHERE id = $1`, [s.id]);
    const far = await makeSite(db, OUT, { prefix: 'FAR' });
    await db.query(`UPDATE sites SET scope_gecol_power = 'yes' WHERE id = $1`, [far.id]);
    const r1 = await approved(t, s1, { remark: 'old remark' });
    await approved({ ...t, site: s3 }, s3, { pr_no: 'GP-3' });

    const dl = await downloadTemplate(t.entry.api, 'TPL-GECOL', `?site_ids=${s1.id},${s3.id}`);
    // update the remark of s1 (matched by Record ID), leave s3 as it is, add s2 (new, matched by Site ID), and four bad rows
    const filled = await fillTemplate(dl.buffer, [
      { [H.site]: s2.code, [H.pr]: 'GP-2', [H.req]: day('2026-01-06'), [H.contractor]: 'Contractor Z' },
      { [H.site]: s4.code, [H.pr]: 'GP-4', [H.req]: day('2099-01-01'), [H.survey]: 'not a date' },
      { [H.site]: far.code, [H.pr]: 'GP-5', [H.req]: day('2026-01-06') },
      { [H.site]: 'NO-SUCH-SITE', [H.pr]: 'GP-6', [H.req]: day('2026-01-06') },
      { [H.site]: s2.code, [H.pr]: 'GP-2B', [H.req]: day('2026-01-07') },
    ], { edit: (wb) => {
      const ws = wb.getWorksheet('Data')!;
      ws.eachRow((row, n) => { if (n > 1 && row.getCell(1).value === s1.code) row.getCell(16).value = 'new remark'; });
    } });
    const up = await uploadFile(t.entry.api, filled, 'gecol.xlsx');
    expect(up.status).toBe(202);
    expect(up.headers.etag).toBe('"1"');
    expect(up.body).toMatchObject({ template_id: 'TPL-GECOL', status: 'validated', register_key: 'gecol', file_name: 'gecol.xlsx', current_level: 1, levels_required: 2, version: 1 });
    expect(up.body.counts).toMatchObject({ create: 1, update: 1, unchanged: 1, error: 4, pending: 2, approved: 0, rejected: 0 });
    expect(up.body.uploaded_by.id).toBe(t.entry.user.id);

    const rows = await rowsOf(t.entry.api, up.body.id);
    const by = (code: string) => rows.filter((r) => r.site_code === code || r.key?.startsWith(code));
    const upd = by(s1.code)[0]!;
    expect(upd).toMatchObject({ action: 'update', decision: 'pending', sheet: 'Data' });
    expect(upd.diff).toEqual({ remark: { old: 'old remark', new: 'new remark' } });
    expect(upd.record_id).toBeNull();                                          // nothing is created before the uploader sends the batch
    expect(by(s3.code)[0]).toMatchObject({ action: 'unchanged', diff: {} });
    const created = by(s2.code).find((r) => r.action === 'create')!;
    expect(created.diff).toMatchObject({ pr_no: { old: null, new: 'GP-2' }, contractor: { old: null, new: 'Contractor Z' }, request_date: { old: null, new: '2026-01-06' } });
    // the second row of the same site in the file is a duplicate
    const dup = by(s2.code).find((r) => r.action === 'error')!;
    expect(dup.errors[0]).toMatchObject({ code: 'duplicate_in_file' });
    // the reasons per cell (header of the column, code, message)
    const bad = by(s4.code)[0]!;
    expect(bad.action).toBe('error');
    expect(bad.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ column: H.req, field: 'request_date', code: 'invalid_date' }),
      expect.objectContaining({ column: H.survey, field: 'survey_date', code: 'invalid_date' }),
    ]));
    // a site outside the caller's regions, and an unknown site, are the same error: nothing is revealed
    const outside = rows.find((r) => r.site_code === far.code)!;
    expect(outside.action).toBe('error');
    expect(outside.errors[0]).toMatchObject({ column: H.site, code: 'site_not_in_scope' });
    const unknown = rows.find((r) => r.key === 'NO-SUCH-SITE' || r.site_code === 'NO-SUCH-SITE')!;
    expect(unknown.errors[0]).toMatchObject({ code: 'site_not_in_scope', message: outside.errors[0].message });

    // filters and the batch list
    expect((await rowsOf(t.entry.api, up.body.id, '?action=error')).length).toBe(4);
    expect((await rowsOf(t.entry.api, up.body.id, '?action=update')).map((r) => r.id)).toEqual([upd.id]);
    expect((await rowsOf(t.entry.api, up.body.id, '?decision=pending')).length).toBe(2);
    const list = await t.entry.api.call('get', '/import-batches?status=validated&template_id=TPL-GECOL');
    expect(list.status).toBe(200);
    expect(list.body.items.map((b: { id: string }) => b.id)).toContain(up.body.id);
    expect((await t.entry.api.call('get', '/import-batches?status=nope')).status).toBe(422);
    // the draft, the audit and the register: nothing changed in the register yet
    expect((await q(db, `SELECT 1 FROM register_records WHERE site_id = $1 AND version_no > 1`, [s1.id])).length).toBe(0);
    expect((await q(db, `SELECT 1 FROM register_records WHERE site_id = $1`, [s2.id])).length).toBe(0);
    const au = await q<{ after: { rows: number } }>(db, `SELECT after FROM audit_log WHERE action = 'import_batch_create' AND entity_id = $1`, [up.body.id]);
    expect(au[0]!.after.rows).toBe(7);
    // the reviewer of the register may read the batch; somebody who may not see the register may not
    expect((await t.approve.api.call('get', `/import-batches/${up.body.id}`)).status).toBe(200);
    const nobody = await actor(app, db, { grants: G('templates', 'view'), regions: [R], modules: null });
    expect((await nobody.api.call('get', `/import-batches/${up.body.id}`)).status).toBe(404);
    expect((await nobody.api.call('get', '/import-batches')).body.items.map((b: { id: string }) => b.id)).not.toContain(up.body.id);
    const noGrant = await actor(app, db, { grants: G('gecol', 'view'), regions: [R], modules: null });
    expect((await noGrant.api.call('get', `/import-batches/${up.body.id}`)).status).toBe(403);
    void r1;
  });

  it('refuses rows an uploader may not enter: a record of a register they hold no L1 on, and update rights', async () => {
    const t = await tplTeam(app, db, 'gecol', 'gecol', R);
    // somebody who may import and sees the register, but is not an entry holder of its Matrix row
    const viewer = await actor(app, db, { level: 'entry', grants: [...G('gecol', 'view', 'create', 'edit'), ...TPL(), ], regions: [R], modules: null });
    const dl = await downloadTemplate(viewer.api, 'TPL-GECOL');
    const filled = await fillTemplate(dl.buffer, [{ [H.site]: t.site.code, [H.pr]: 'GP-9', [H.req]: day('2026-01-06') }]);
    const up = await uploadFile(viewer.api, filled);
    expect(up.status).toBe(202);
    const rows = await rowsOf(viewer.api, up.body.id);
    expect(rows[0]).toMatchObject({ action: 'error' });
    expect(rows[0]!.errors[0]).toMatchObject({ code: 'not_entry_holder' });
    // the caller may edit but not create: a new record is an error row (rights per row)
    const noCreate = await actor(app, db, { level: 'entry', grants: [...G('gecol', 'view', 'edit'), ...TPL()], regions: [R], modules: null });
    const up2 = await uploadFile(noCreate.api, (await fillTemplate((await downloadTemplate(noCreate.api, 'TPL-GECOL')).buffer, [{ [H.site]: t.site.code, [H.pr]: 'GP-9', [H.req]: day('2026-01-06') }])));
    expect((await rowsOf(noCreate.api, up2.body.id))[0]!.errors[0]).toMatchObject({ code: 'action_forbidden' });
    // the caller may neither create nor edit: the whole file is refused (and the refusal is logged)
    const viewOnly = await actor(app, db, { level: 'entry', grants: [...G('gecol', 'view'), ...TPL()], regions: [R], modules: null });
    const none = await uploadFile(viewOnly.api, (await fillTemplate((await downloadTemplate(viewOnly.api, 'TPL-GECOL')).buffer, [{ [H.site]: t.site.code, [H.pr]: 'GP-9', [H.req]: day('2026-01-06') }])));
    expect(none.status).toBe(422);
    expect(none.body).toMatchObject({ code: 'template_rejected', reason: 'import_not_allowed' });
    expect((await logRows('import_not_allowed'))[0]).toMatchObject({ user_id: viewOnly.user.id });
  });
});

const TPL = (): [string, string][] => G('templates', 'view', 'import', 'download_documents');

describe('batch: into the normal flow, row by row and all at once', () => {
  it('sends the valid rows as records into Entry then L2, approves row by row, and shows "via batch" in the audit and the history', async () => {
    const t = await tplTeam(app, db, 'gecol', 'gecol', R);
    const s1 = t.site;
    const s2 = await makeSite(db, R, { prefix: 'TPL' });
    const s3 = await makeSite(db, R, { prefix: 'TPL' });
    for (const s of [s2, s3]) await db.query(`UPDATE sites SET scope_gecol_power = 'yes' WHERE id = $1`, [s.id]);
    const base = await approved(t, s1, { remark: 'old' });
    const dl = await downloadTemplate(t.entry.api, 'TPL-GECOL', `?site_ids=${s1.id}`);
    const filled = await fillTemplate(dl.buffer, [
      { [H.site]: s2.code, [H.pr]: 'GP-2', [H.req]: day('2026-01-06') },
      { [H.site]: s3.code, [H.pr]: 'GP-3', [H.req]: day('2026-01-07') },
    ], { edit: (wb) => { wb.getWorksheet('Data')!.getRow(2).getCell(16).value = 'changed by file'; } });
    const up = await uploadFile(t.entry.api, filled, 'flow.xlsx');
    expect(up.body.counts).toMatchObject({ create: 2, update: 1, error: 0 });
    const id = up.body.id as string;

    // permission denied: somebody who did not upload cannot send it; the uploader needs the current ETag
    expect((await t.review.api.call('post', `/import-batches/${id}/submit`, undefined, { 'If-Match': '"1"' })).status).toBe(403);
    expect((await t.entry.api.call('post', `/import-batches/${id}/submit`)).status).toBe(428);
    expect((await t.entry.api.call('post', `/import-batches/${id}/submit`, undefined, { 'If-Match': '"9"' })).status).toBe(412);
    // an approval before the batch is sent is not possible
    await t.approve.api.stepUp(t.approve.user.password);
    const early = await t.approve.api.call('post', `/import-batches/${id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': '"1"' });
    expect(early.status).toBe(409);

    const sub = await t.entry.api.call('post', `/import-batches/${id}/submit`, undefined, { 'If-Match': '"1"' });
    expect(sub.status).toBe(200);
    expect(sub.body).toMatchObject({ status: 'in_approval', version: 2, current_level: 2 });
    expect(sub.body.outcome).toMatchObject({ submitted: 3, held: [], failed: [] });
    expect(sub.body.counts).toMatchObject({ pending: 3, approved: 0 });
    const rows = await rowsOf(t.entry.api, id);
    expect(rows.every((r) => r.record_id)).toBe(true);

    // the records are in the normal flow: Entry (the uploader, L1) done, now at L2 (approve), source template, linked to the batch row
    const recs = await q<{ id: string; state: string; source: string; batch_row_id: string; version_no: number; entity_id: string; data: Record<string, unknown> }>(
      db, `SELECT id, state, source, batch_row_id, version_no, entity_id, data FROM register_records WHERE batch_row_id = ANY($1::uuid[]) ORDER BY created_at`, [rows.map((r) => r.id)]);
    expect(recs).toHaveLength(3);
    expect(recs.every((r) => r.state === 'in_approval' && r.source === 'template')).toBe(true);
    const upd = recs.find((r) => r.entity_id === base.entity_id)!;
    expect(upd.version_no).toBe(2);
    expect(upd.data).toMatchObject({ remark: 'changed by file', pr_no: 'GP-1' });
    const steps = await q<{ action: string; batch_row_id: string | null; acted_by: string }>(db, `SELECT action, batch_row_id, acted_by FROM register_steps WHERE record_id = $1 ORDER BY created_at`, [upd.id]);
    expect(steps.map((s) => s.action)).toEqual(['new_version', 'edit', 'submit']);
    expect(steps.every((s) => s.batch_row_id === rows.find((r) => r.site_code === s1.code)!.id)).toBe(true);
    const aud = await q<{ action: string; after: { via?: string; batch_id?: string } }>(db, `SELECT action, after FROM audit_log WHERE entity_type = 'register_record' AND entity_id = $1 ORDER BY id`, [upd.id]);
    expect(aud.map((a) => a.action)).toEqual(['register_record_new_version', 'register_record_update', 'register_record_submit']);
    expect(aud.every((a) => a.after.via === 'batch' && a.after.batch_id === id)).toBe(true);
    // the typed (approved) table keeps the approved value until the approval
    expect((await q<{ remark: string }>(db, `SELECT remark FROM gecol_records WHERE id = $1`, [base.entity_id]))[0]!.remark).toBe('old');
    // the record history of the API shows the batch row
    const hist = await t.entry.api.call('get', recPath('gecol', upd.id, '/history'));
    expect(hist.body.items.map((s: { batch_row_id: string | null }) => s.batch_row_id).filter(Boolean)).toHaveLength(3);

    // the uploader holds only L1: approving is refused (not the holder)
    const own = await t.entry.api.call('post', `/import-batches/${id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': '"2"' });
    expect(own.status).toBe(403);
    // the reviewer (a person without the approve right) is refused
    expect((await t.review.api.call('post', `/import-batches/${id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': '"2"' })).status).toBe(403);
    // without a step-up the final approval asks for one
    const fresh = await t.approve.api.call('post', `/import-batches/${id}/decisions`, { action: 'reject', scope: 'rows', rows: [{ row_id: rows[0]!.id, decision: 'rejected' }] }, { 'If-Match': '"2"' });
    expect(fresh.status).toBe(422);                                                     // a return needs a note
    expect(fresh.body.code).toBe('note_required');

    // approve one row (the update): the record in force changes through the normal approval
    const updRow = rows.find((r) => r.site_code === s1.code)!;
    const one = await t.approve.api.call('post', `/import-batches/${id}/decisions`, { action: 'approve', scope: 'rows', rows: [{ row_id: updRow.id, decision: 'approved' }] }, { 'If-Match': '"2"' });
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ status: 'partially_approved', version: 3 });
    expect(one.body.counts).toMatchObject({ approved: 1, pending: 2 });
    expect(one.body.outcome).toMatchObject({ decided: 1, approved: 1, rejected: 0 });
    expect((await q<{ remark: string; record_version: number }>(db, `SELECT remark, record_version FROM gecol_records WHERE id = $1`, [base.entity_id]))[0]).toMatchObject({ remark: 'changed by file', record_version: 2 });
    const after = await q<{ state: string; is_current: boolean; approved_by: string }>(db, `SELECT state, is_current, approved_by FROM register_records WHERE id = $1`, [upd.id]);
    expect(after[0]).toMatchObject({ state: 'approved', is_current: true, approved_by: t.approve.user.id });
    expect((await rowsOf(t.entry.api, id, '?decision=approved')).map((r) => r.id)).toEqual([updRow.id]);

    // reject one row with a note: it goes back to the uploader at Entry (L1)
    const newRow = rows.find((r) => r.site_code === s3.code)!;
    const back = await t.approve.api.call('post', `/import-batches/${id}/decisions`, { action: 'reject', scope: 'rows', rows: [{ row_id: newRow.id, decision: 'rejected', note: 'wrong request date' }] }, { 'If-Match': '"3"' });
    expect(back.status).toBe(200);
    expect(back.body.counts).toMatchObject({ rejected: 1, approved: 1, pending: 1 });
    const returned = await q<{ state: string; last_return_note: string }>(db, `SELECT state, last_return_note FROM register_records WHERE id = $1`, [newRow.record_id]);
    expect(returned[0]).toMatchObject({ state: 'entry', last_return_note: 'wrong request date' });
    expect((await rowsOf(t.entry.api, id, '?decision=rejected'))[0]).toMatchObject({ id: newRow.id, note: 'wrong request date' });
    const note = await q<{ n: string }>(db, `SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND kind = 'import_batch'`, [t.entry.user.id]);
    expect(Number(note[0]!.n)).toBeGreaterThanOrEqual(2);

    // approve all: the last pending row
    const all = await t.approve.api.call('post', `/import-batches/${id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': '"4"' });
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ status: 'approved' });
    expect(all.body.counts).toMatchObject({ approved: 2, rejected: 1, pending: 0 });
    expect((await q<{ pr_no: string }>(db, `SELECT pr_no FROM gecol_records WHERE site_id = $1`, [s2.id]))[0]!.pr_no).toBe('GP-2');
    expect((await q(db, `SELECT 1 FROM gecol_records WHERE site_id = $1`, [s3.id])).length).toBe(0);          // the returned row is not in force
    // decisions on a finished batch
    expect((await t.approve.api.call('post', `/import-batches/${id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': `"${all.body.version}"` })).status).toBe(409);
    // the audit of the decision
    const ba = await q<{ action: string; after: { decided: number; status: string } }>(db, `SELECT action, after FROM audit_log WHERE entity_type = 'import_batch' AND entity_id = $1 ORDER BY id`, [id]);
    expect(ba.map((x) => x.action)).toEqual(['import_batch_create', 'import_batch_submit', 'import_batch_approve', 'import_batch_reject', 'import_batch_approve']);
  });

  it('holds a row whose record still has an open version: "approve all" lists it and leaves it, and a later send releases it', async () => {
    const t = await tplTeam(app, db, 'gecol', 'gecol', R);
    const s1 = t.site;
    const s2 = await makeSite(db, R, { prefix: 'TPL' });
    await db.query(`UPDATE sites SET scope_gecol_power = 'yes' WHERE id = $1`, [s2.id]);
    const base1 = await approved(t, s1, { remark: 'v1' });
    await approved({ ...t, site: s2 }, s2, { pr_no: 'GP-2' });
    // a manual new version of the first record is open (a draft in Entry)
    const nv = await t.entry.api.call('post', recPath('gecol', base1.id, '/versions'), undefined, { 'If-Match': `"${base1.version}"` });
    expect(nv.status).toBe(201);

    const dl = await downloadTemplate(t.entry.api, 'TPL-GECOL', `?site_ids=${s1.id},${s2.id}`);
    const filled = await fillTemplate(dl.buffer, [], { edit: (wb) => {
      const ws = wb.getWorksheet('Data')!;
      ws.eachRow((row, n) => {
        if (n === 1) return;
        if (row.getCell(1).value === s1.code) row.getCell(16).value = 'from file';
        if (row.getCell(1).value === s2.code) row.getCell(16).value = 'second';
      });
    } });
    const up = await uploadFile(t.entry.api, filled);
    expect(up.body.counts).toMatchObject({ update: 2, pending: 1, held: 1 });
    const rows = await rowsOf(t.entry.api, up.body.id);
    const held = rows.find((r) => r.site_code === s1.code)!;
    expect(held).toMatchObject({ action: 'update', decision: 'pending_previous_approval', hold_reason: 'open_version' });
    expect((await rowsOf(t.entry.api, up.body.id, '?decision=pending_previous_approval')).map((r) => r.id)).toEqual([held.id]);

    const id = up.body.id as string;
    const sub = await t.entry.api.call('post', `/import-batches/${id}/submit`, undefined, { 'If-Match': '"1"' });
    expect(sub.body.outcome.submitted).toBe(1);
    expect(sub.body.outcome.held).toEqual([expect.objectContaining({ row_id: held.id, reason: 'open_version', record_id: nv.body.id })]);
    expect(sub.body.status).toBe('in_approval');

    await t.approve.api.stepUp(t.approve.user.password);
    const all = await t.approve.api.call('post', `/import-batches/${id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': `"${sub.body.version}"` });
    expect(all.status).toBe(200);
    expect(all.body.outcome).toMatchObject({ decided: 1, approved: 1 });
    expect(all.body.outcome.held).toEqual([expect.objectContaining({ row_id: held.id, key: s1.code, reason: 'open_version' })]);
    expect(all.body.status).toBe('partially_approved');                          // the held row keeps the batch open
    expect(all.body.counts).toMatchObject({ approved: 1, held: 1, pending: 0 });
    expect((await q<{ remark: string }>(db, `SELECT remark FROM gecol_records WHERE site_id = $1`, [s1.id]))[0]!.remark).toBe('v1');   // untouched
    expect((await q<{ remark: string }>(db, `SELECT remark FROM gecol_records WHERE site_id = $1`, [s2.id]))[0]!.remark).toBe('second');

    // a held row is returned only by the uploader or an L2 holder: a stranger with the module rights is refused and nothing changes
    const stranger = await actor(app, db, { level: 'approve', regions: [R], modules: null, grants: G('gecol', 'view', 'approve') });
    await addAssignment(db, stranger.user.id, { level: 'approve', regions: [R], modules: null, grants: G('templates', 'view') });
    await stranger.api.stepUp(stranger.user.password);
    const sx = await stranger.api.call('post', `/import-batches/${id}/decisions`, { action: 'reject', scope: 'rows', rows: [{ row_id: held.id, decision: 'rejected', note: 'no' }] }, { 'If-Match': `"${all.body.version}"` });
    expect(sx.status).toBe(403);
    expect((await rowsOf(t.entry.api, id)).find((r) => r.id === held.id)).toMatchObject({ decision: 'pending_previous_approval' });

    // the open version is voided: the next send releases the held row into the flow
    await db.query(`UPDATE register_records SET state = 'voided' WHERE id = $1`, [nv.body.id]);
    const again = await t.entry.api.call('post', `/import-batches/${id}/submit`, undefined, { 'If-Match': `"${all.body.version}"` });
    expect(again.status).toBe(200);
    expect(again.body.outcome).toMatchObject({ submitted: 1, held: [] });
    const fin = await t.approve.api.call('post', `/import-batches/${id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': `"${again.body.version}"` });
    expect(fin.body.status).toBe('approved');
    expect((await q<{ remark: string }>(db, `SELECT remark FROM gecol_records WHERE site_id = $1`, [s1.id]))[0]!.remark).toBe('from file');
  });

  it('returns every open row with one note, discards an unsent batch, and refuses to discard a sent one', async () => {
    const t = await tplTeam(app, db, 'gecol', 'gecol', R);
    const s2 = await makeSite(db, R, { prefix: 'TPL' });
    await db.query(`UPDATE sites SET scope_gecol_power = 'yes' WHERE id = $1`, [s2.id]);
    const dl = await downloadTemplate(t.entry.api, 'TPL-GECOL');
    const mk = async (code: string, pr: string): Promise<Record<string, any>> => (await uploadFile(t.entry.api, await fillTemplate(dl.buffer, [{ [H.site]: code, [H.pr]: pr, [H.req]: day('2026-01-06') }]))).body;
    // discard before sending: nothing was ever created
    const a = await mk(t.site.code, 'GP-D1');
    expect((await t.review.api.call('post', `/import-batches/${a.id}/decisions`, { action: 'discard', scope: 'all' }, { 'If-Match': '"1"' })).status).toBe(403);
    const d = await t.entry.api.call('post', `/import-batches/${a.id}/decisions`, { action: 'discard', scope: 'all', note: 'wrong file' }, { 'If-Match': '"1"' });
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ status: 'discarded', note: 'wrong file' });
    expect((await q(db, `SELECT 1 FROM register_records WHERE site_id = $1`, [t.site.id])).length).toBe(0);
    expect((await t.entry.api.call('post', `/import-batches/${a.id}/submit`, undefined, { 'If-Match': `"${d.body.version}"` })).status).toBe(409);
    // return all with a note after sending
    const b = await mk(s2.code, 'GP-D2');
    const sub = await t.entry.api.call('post', `/import-batches/${b.id}/submit`, undefined, { 'If-Match': '"1"' });
    expect((await t.entry.api.call('post', `/import-batches/${b.id}/decisions`, { action: 'discard', scope: 'all' }, { 'If-Match': `"${sub.body.version}"` })).status).toBe(409);
    expect((await t.approve.api.call('post', `/import-batches/${b.id}/decisions`, { action: 'reject', scope: 'all' }, { 'If-Match': `"${sub.body.version}"` })).status).toBe(422);
    const ret = await t.approve.api.call('post', `/import-batches/${b.id}/decisions`, { action: 'reject', scope: 'all', note: 'send again with the contractor' }, { 'If-Match': `"${sub.body.version}"` });
    expect(ret.status).toBe(200);
    expect(ret.body).toMatchObject({ status: 'rejected', note: 'send again with the contractor' });
    const rec = await q<{ state: string; return_count: number }>(db, `SELECT state, return_count FROM register_records WHERE site_id = $1`, [s2.id]);
    expect(rec[0]).toMatchObject({ state: 'entry', return_count: 1 });                 // back at L1: the uploader fixes it in the register and sends it again
  });

  it('applies a self-approval through the same rules: the uploader who also holds L2 needs a step-up and is flagged', async () => {
    // one person holds L1 and L2 of the register row
    const both = await actor(app, db, { level: 'approve', grants: [...G('gecol', 'view', 'create', 'edit', 'approve'), ...TPL()], regions: [R], modules: null, stepUp: false });
    const { regCell } = await import('./reg-helpers');
    await regCell(db, 'gecol', R, 'entry', { user: [both.user.id] });
    await regCell(db, 'gecol', R, 'approve', { user: [both.user.id] });
    const s2 = await makeSite(db, R, { prefix: 'TPL' });
    await db.query(`UPDATE sites SET scope_gecol_power = 'yes' WHERE id = $1`, [s2.id]);
    const dl = await downloadTemplate(both.api, 'TPL-GECOL');
    const up = await uploadFile(both.api, await fillTemplate(dl.buffer, [{ [H.site]: s2.code, [H.pr]: 'GP-S', [H.req]: day('2026-01-06') }]));
    expect(up.status).toBe(202);
    const no = await both.api.call('post', `/import-batches/${up.body.id}/submit`, undefined, { 'If-Match': '"1"' });
    expect(no.status).toBe(401);
    expect(no.body.code).toBe('step_up_required');
    expect((await q(db, `SELECT 1 FROM register_records WHERE site_id = $1`, [s2.id])).length).toBe(0);          // all or nothing
    await both.api.stepUp(both.user.password);
    const ok = await both.api.call('post', `/import-batches/${up.body.id}/submit`, undefined, { 'If-Match': '"1"' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
    const rec = await q<{ state: string; self_approval: boolean }>(db, `SELECT state, self_approval FROM register_records WHERE site_id = $1`, [s2.id]);
    expect(rec[0]).toMatchObject({ state: 'approved', self_approval: true });
    // restore the team's cells for the following suites
    await db.query('DELETE FROM matrix_cells WHERE register_key = $1 AND region_id = $2', ['gecol', R]);
    void post;
  });
});

describe('a register without a site, and custom fields', () => {
  it('shows an admin-added field as a column of the next version, reads it, and enters the record through the normal flow', async () => {
    // Meetings have no site (global rows): the entry and approve cells of the row are global
    const entry = await actor(app, db, { level: 'entry', grants: [...G('meetings', 'view', 'create', 'edit'), ...TPL()], regions: [R], modules: null });
    const approve = await actor(app, db, { level: 'approve', grants: [...G('meetings', 'view', 'approve'), ...G('templates', 'view')], regions: [R], modules: null });
    await db.query(`DELETE FROM matrix_cells WHERE register_key = 'meetings' AND region_id IS NULL AND level IN (1, 3)`);
    for (const [level, user] of [[1, entry.user.id], [3, approve.user.id]] as const) {
      const c = await db.query(`INSERT INTO matrix_cells (register_key, level, rule, is_global, updated_at) VALUES ('meetings', $1, 'any_one', true, now()) RETURNING id`, [level]);
      await db.query(`INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, 'user', $2)`, [c.rows[0].id, user]);
    }
    const before = (await entry.api.call('get', '/templates')).body.items.find((i: { template_id: string }) => i.template_id === 'TPL-MTG').current_version as number;
    const f = await db.query(`INSERT INTO field_definitions (entity_type, code, label_en, data_type, in_templates, is_active) VALUES ('meeting', 'probe_note', 'Probe note', 'text', true, true) RETURNING id`);
    try {
      const now = (await entry.api.call('get', '/templates')).body.items.find((i: { template_id: string }) => i.template_id === 'TPL-MTG').current_version as number;
      expect(now).toBe(before + 1);
      const dl = await downloadTemplate(entry.api, 'TPL-MTG');
      const headers = (await load(dl.buffer)).getWorksheet('Data')!.getRow(1).values as string[];
      expect(headers).toEqual(expect.arrayContaining(['Date', 'Title', 'Probe note', 'Record ID']));
      expect(headers).not.toContain('Site ID');                                // no site column for a register without a site
      const up = await uploadFile(entry.api, await fillTemplate(dl.buffer, [{ 'Date': day('2026-02-03'), Title: 'Kick-off', 'Probe note': 'hello' }]));
      expect(up.status).toBe(202);
      expect(up.body.counts).toMatchObject({ create: 1, error: 0 });
      const rows = await rowsOf(entry.api, up.body.id);
      expect(rows[0]).toMatchObject({ action: 'create', key: '2026-02-03 / Kick-off' });
      expect(rows[0]!.diff).toMatchObject({ title: { old: null, new: 'Kick-off' }, probe_note: { old: null, new: 'hello' } });
      const sub = await entry.api.call('post', `/import-batches/${up.body.id}/submit`, undefined, { 'If-Match': '"1"' });
      expect(sub.body.outcome).toMatchObject({ submitted: 1, failed: [] });
      const rec = await q<{ id: string; custom: Record<string, unknown>; state: string; is_global: boolean }>(db, `SELECT id, custom, state, is_global FROM register_records WHERE batch_row_id = $1`, [rows[0]!.id]);
      expect(rec[0]).toMatchObject({ state: 'in_approval', custom: { probe_note: 'hello' }, is_global: true });
      await approve.api.stepUp(approve.user.password);
      const done = await approve.api.call('post', `/import-batches/${up.body.id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': `"${sub.body.version}"` });
      expect(done.body).toMatchObject({ status: 'approved' });
      // the same file again matches the record by its key: nothing changed
      const again = await uploadFile(entry.api, await fillTemplate(dl.buffer, [{ 'Date': day('2026-02-03'), Title: 'Kick-off', 'Probe note': 'hello' }]));
      expect(again.body.counts).toMatchObject({ unchanged: 1, create: 0, update: 0 });
      // a bad custom value is a cell error: a Probe note longer than the field allows is not our case, but a wrong type for a field is
      const bad = await uploadFile(entry.api, await fillTemplate(dl.buffer, [{ 'Date': 'tomorrow', Title: 'x' }]));
      expect((await rowsOf(entry.api, bad.body.id))[0]!.errors[0]).toMatchObject({ column: 'Date', field: 'meeting_date', code: 'invalid_date' });
    } finally {
      await db.query(`UPDATE field_definitions SET is_active = false WHERE id = $1`, [f.rows[0].id]);
    }
    expect(((await entry.api.call('get', '/templates')).body.items.find((i: { template_id: string }) => i.template_id === 'TPL-MTG').current_version as number)).toBe(before + 2);
  });
});

describe('the database', () => {
  it('has no direct write path for the application role on the new tables or functions', async () => {
    const app_ = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
    await app_.connect();
    try {
      for (const sql of [
        `INSERT INTO import_batches (template_version_id, file_name, file_sha256, uploaded_by) SELECT id, 'x', 'x', gen_random_uuid() FROM template_versions LIMIT 1`,
        `UPDATE import_batch_rows SET decision = 'approved'`,
        `DELETE FROM import_batches`,
        `UPDATE template_versions SET is_current = false`,
        `UPDATE template_definitions SET is_active = false`,
        `INSERT INTO template_versions (template_def_id, version, header_checksum, columns) SELECT id, 99, 'x', '[]' FROM template_definitions LIMIT 1`,
        `SELECT reg_save_record('gecol', NULL, NULL, NULL, NULL, '{}', NULL, NULL, false, gen_random_uuid())`,
        `SELECT reg_transition_record(gen_random_uuid(), 1, 'approve', NULL, true, gen_random_uuid())`,
        `SELECT tpl_sync_all()`,
      ]) {
        await expect(app_.query(sql)).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|42883)$/) });
      }
    } finally {
      await app_.end();
    }
  });

  it('issues the header checksum the upload recomputes, and one current version per template', async () => {
    const cur = await q<{ template_id: string; n: string }>(db, `SELECT d.template_id, count(*) FILTER (WHERE v.is_current)::text AS n FROM template_definitions d JOIN template_versions v ON v.template_def_id = d.id GROUP BY 1`);
    expect(cur.length).toBeGreaterThanOrEqual(16);
    expect(cur.every((c) => c.n === '1')).toBe(true);
    const v = await q<{ columns: { header: string }[]; header_checksum: string }>(db, `SELECT v.columns, v.header_checksum FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-PRM' AND v.is_current`);
    expect(sha(v[0]!.columns.map((c) => c.header).join('\u001f'))).toBe(v[0]!.header_checksum);
  });
});

/** Adds one part to an xlsx package (to build a file that carries a VBA project). The central directory is rebuilt by exceljs-free zip code: a stored entry. */
async function addZipEntry(zip: Buffer, name: string, data: Buffer): Promise<Buffer> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(eocd + 10);
  const dirOffset = zip.readUInt32LE(eocd + 16);
  const dir = zip.subarray(dirOffset, eocd);
  const nameBuf = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  const entry = Buffer.concat([local, nameBuf, data]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(dirOffset, 42);
  const newDir = Buffer.concat([dir, central, nameBuf]);
  const end = Buffer.from(zip.subarray(eocd));
  end.writeUInt16LE(count + 1, 8); end.writeUInt16LE(count + 1, 10); end.writeUInt32LE(newDir.length, 12); end.writeUInt32LE(dirOffset + entry.length, 16);
  return Buffer.concat([zip.subarray(0, dirOffset), entry, newDir, end]);
}

function crc32(b: Buffer): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

void getBinary;
