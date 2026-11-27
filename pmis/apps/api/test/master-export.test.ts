import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, sleep, startApp, superDb } from './helpers';
import { G, GECOL, createRec, team } from './reg-helpers';
import { actor, makeSite, makeTask, plainAdmin, type Site } from './wf-helpers';
import { MasterExportService } from '../src/exports/master-export.service';
import { masterHeaderRows } from '../src/exports/master-layout';

/**
 * Master-format export (contract 0.2.2, 0.2.3, 0.15.34): parts by export grant and region (B3), a background job that writes the Site Master layout
 * (Master sheet header rows and the values of site_master_values), region limits, the current view with its filters, audit and ownership.
 * Sites of this file live in GM (6) and Sebha (7) and every export is limited to those regions.
 */
const TAG = randomBytes(3).toString('hex').toUpperCase();
let app: NestExpressApplication;
let db: PgClient;
let gm: Site, sebha: Site, sebha2: Site;
let dateMap: { task_code: string; ord: number };

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  const r = await db.query(`SELECT tf.task_code, mc.ord FROM template_task_fields tf JOIN master_columns mc ON mc.letter = tf.master_col
    WHERE tf.field_key = 'actual_date' AND tf.is_active AND tf.scenarios IS NULL AND tf.projection IS NULL
      AND EXISTS (SELECT 1 FROM task_definitions td JOIN workflow_definitions w ON w.id = td.workflow_id AND w.version = 1 WHERE td.code = tf.task_code)
    ORDER BY mc.ord LIMIT 1`);
  dateMap = r.rows[0] as { task_code: string; ord: number };
  gm = await makeSite(db, 6, { prefix: `MX${TAG}G` });
  sebha = await makeSite(db, 7, { prefix: `MX${TAG}S`, status: 'on_hold' });
  sebha2 = await makeSite(db, 7, { prefix: `MX${TAG}T` });
  await makeTask(db, sebha, dateMap.task_code, 'open', { actualDate: '2026-03-10' });
  await db.query(`UPDATE sites SET sub_region = 'South', project_phase = 'Phase 1' WHERE id = $1`, [sebha.id]);
});
afterAll(async () => {
  await app.get(MasterExportService).idle();
  await db.end();
  await app.close();
});

const EXPORTER: [string, string][] = [['sites', 'view'], ['sites', 'export'], ['gecol', 'view']];

async function finished(api: Api, id: string): Promise<Record<string, any>> {
  await app.get(MasterExportService).idle();
  for (let i = 0; i < 100; i++) {
    const list = await api.call('get', '/exports/master');
    expect(list.status).toBe(200);
    const e = list.body.items.find((x: { id: string }) => x.id === id);
    if (e && (e.status === 'done' || e.status === 'failed')) return e;
    await sleep(100);
  }
  throw new Error('the export did not finish');
}

const fetchBook = async (api: Api, id: string): Promise<{ status: number; book?: ExcelJS.Workbook; headers: Record<string, string> }> => {
  const res = await api.call('get', `/exports/master/${id}/download`).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  if (res.status !== 200) return { status: res.status, headers: res.headers as Record<string, string> };
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(res.body as unknown as ExcelJS.Buffer);
  return { status: 200, book, headers: res.headers as Record<string, string> };
};

const text = (v: ExcelJS.CellValue): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
};
const rowValues = (ws: ExcelJS.Worksheet, n: number, count: number): (string | null)[] => Array.from({ length: count }, (_, i) => text(ws.getRow(n).getCell(i + 1).value));
const siteRows = (ws: ExcelJS.Worksheet, first: number): Map<string, number> => {
  const out = new Map<string, number>();
  ws.eachRow((row, n) => { if (n >= first) { const v = text(row.getCell(2).value); if (v) out.set(v, n); } });
  return out;
};

describe('GET /exports/parts', () => {
  it('lists only the parts the caller may export (export grant); the five registers with no Master columns are parts too (0.15.310)', async () => {
    const a = await actor(app, db, { regions: [7], grants: EXPORTER });
    const res = await a.api.call('get', '/exports/parts');
    expect(res.status).toBe(200);
    const keys = res.body.items.map((p: { key: string }) => p.key);
    expect(keys).toEqual(['sites', 'milestones', 'tasks']);
    expect(res.body.items[0]).toMatchObject({ key: 'sites', master_sheet: 'Master', label_en: 'Sites' });
    const admin = await plainAdmin(app, db, false);
    const all = (await admin.api.call('get', '/exports/parts')).body.items.map((p: { key: string }) => p.key);
    expect(all).toEqual(expect.arrayContaining(['sites', 'gecol', 'procurement', 'risks', 'dismantle', 'project_status', 'rf_design']));
    expect(all).toEqual(expect.arrayContaining(['car_dispatcher', 'financial_advances', 'incidents', 'lessons_learned', 'invoices']));
    const fin = await actor(app, db, { regions: [7], grants: [['invoices', 'view'], ['invoices', 'export']] });
    const own = (await fin.api.call('get', '/exports/parts')).body.items.map((p: { key: string; master_sheet: string }) => `${p.key}:${p.master_sheet}`);
    expect(own).toEqual(['invoices:Invoices']);
  });

  it('serves the stable column codes with include_columns=true', async () => {
    const a = await actor(app, db, { regions: [7], grants: [...EXPORTER, ['gecol', 'export']] });
    const res = await a.api.call('get', '/exports/parts?include_columns=true');
    const sites = res.body.items.find((p: { key: string }) => p.key === 'sites');
    const codes = sites.columns.map((c: { code: string }) => c.code);
    expect(codes).toEqual(expect.arrayContaining(['site_code', 'site_name', 'region', 'scenario', 'overall_status', 'current_stage', 'm_b', 'm_ge']));
    expect(sites.columns.find((c: { code: string }) => c.code === 'site_code').master_column).toBe('B');
    const gecol = res.body.items.find((p: { key: string }) => p.key === 'gecol').columns.map((c: { code: string }) => c.code);
    expect(gecol).toEqual(expect.arrayContaining(['site_code', 'state', 'pr_no', 'contractor']));
  });
});

describe('GET /exports/parts: columns of another part', () => {
  it('does not offer the Master columns of a part the caller may not export (Dismantle FN:FW) and refuses them in a view export', async () => {
    const a = await actor(app, db, { regions: [7], grants: EXPORTER });
    const res = await a.api.call('get', '/exports/parts?include_columns=true');
    const codes = res.body.items.find((p: { key: string }) => p.key === 'sites').columns.map((c: { code: string }) => c.code);
    expect(codes).toContain('m_b');
    expect(codes).not.toContain('m_fn');
    expect(codes).not.toContain('m_fw');
    const start = await a.api.call('post', '/exports/master', { view: { source: 'sites', filters: {}, columns: ['site_code', 'm_fn'] } });
    expect(start.status).toBe(422);
    const d = await actor(app, db, { regions: [7], grants: [...EXPORTER, ['dismantle', 'view'], ['dismantle', 'export']] });
    const res2 = await d.api.call('get', '/exports/parts?include_columns=true');
    expect(res2.body.items.find((p: { key: string }) => p.key === 'sites').columns.map((c: { code: string }) => c.code)).toContain('m_fn');
  });
});

describe('POST /exports/master: checks', () => {
  it('refuses parts without the export grant (403 lists them), parts and view together, foreign regions and past dates', async () => {
    const a = await actor(app, db, { regions: [7], grants: EXPORTER });
    let r = await a.api.call('post', '/exports/master', { parts: ['sites', 'gecol'] });
    expect(r.status).toBe(403);
    expect(r.body.errors).toEqual([expect.objectContaining({ path: '/parts/gecol', code: 'export_denied' })]);
    for (const k of ['car_dispatcher', 'financial_advances', 'incidents', 'lessons_learned', 'invoices']) {
      r = await a.api.call('post', '/exports/master', { parts: [k] });
      expect(r.status).toBe(403);
      expect(r.body.errors).toEqual([expect.objectContaining({ path: `/parts/${k}`, code: 'export_denied' })]);
    }
    r = await a.api.call('post', '/exports/master', { parts: ['sites'], view: { source: 'sites', filters: {}, columns: ['site_code'] } });
    expect(r.status).toBe(422);
    r = await a.api.call('post', '/exports/master', { parts: ['sites'], regions: [5] });
    expect(r.status).toBe(422);
    expect(r.body.errors[0]).toMatchObject({ path: '/regions', code: 'out_of_scope' });
    r = await a.api.call('post', '/exports/master', { parts: ['sites'], as_of: '2020-01-01' });
    expect(r.status).toBe(422);
    r = await a.api.call('post', '/exports/master', { view: { source: 'sites', filters: {}, columns: ['nope_col'] } });
    expect(r.status).toBe(422);
    expect(r.body.errors[0].path).toBe('/view/columns/0');
    const none = await actor(app, db, { regions: [7], grants: [['sites', 'view']] });
    expect((await none.api.call('post', '/exports/master', {})).status).toBe(403);
  });
});

describe('the background job and the workbook', () => {
  it('writes the Master sheet in the Master layout with the values of site_master_values, limited to the caller\'s regions; audited; owner-only download', async () => {
    const a = await actor(app, db, { regions: [7], grants: EXPORTER });
    const start = await a.api.call('post', '/exports/master', {}, { 'Idempotency-Key': `mx-full-${TAG}` });
    expect(start.status).toBe(202);
    expect(start.body).toMatchObject({ kind: 'master_export', status: 'queued' });
    const e = await finished(a.api, start.body.id);
    expect(e).toMatchObject({ status: 'done', kind: 'full', parts: ['sites', 'milestones', 'tasks'], job_id: start.body.id });
    expect(e.row_count).toBeGreaterThanOrEqual(2);
    expect(e.expires_at).toEqual(expect.any(String));
    const job = await a.api.call('get', `/jobs/${start.body.id}`);
    expect(job.body).toMatchObject({ kind: 'master_export', status: 'done' });
    expect(job.body.result.download_path).toBe(`/exports/master/${start.body.id}/download`);

    const f = await fetchBook(a.api, start.body.id);
    expect(f.status).toBe(200);
    expect(f.headers['cache-control']).toBe('no-store');
    expect(f.headers['content-disposition']).toMatch(/GSDN_Site_Master_\d{8}\.xlsx/);
    const ws = f.book!.getWorksheet('Master')!;
    const cols = (await db.query(`SELECT ord, letter, group_top, group_mid, NULLIF(name, '') AS name FROM master_columns WHERE is_active ORDER BY ord`)).rows;
    expect(cols).toHaveLength(187);
    const head = masterHeaderRows(cols);
    for (let i = 0; i < 3; i++) expect(rowValues(ws, i + 1, 187)).toEqual(head[i]);
    expect(rowValues(ws, 3, 3)).toEqual([null, 'Site ID', 'Site Owner ID']);
    expect(rowValues(ws, 1, 2)).toEqual(['#', 'RF & DESIGN']);

    const rows = siteRows(ws, 5);
    expect(rows.has(sebha.code)).toBe(true);
    expect(rows.has(sebha2.code)).toBe(true);
    expect(rows.has(gm.code)).toBe(false); // GM is outside the caller's regions
    const values = (await db.query(`SELECT ord, value FROM site_master_values WHERE site_id = $1 AND register_key IS NULL`, [sebha.id])).rows as { ord: number; value: string | null }[];
    const got = rowValues(ws, rows.get(sebha.code)!, 187);
    for (const v of values) if (v.value !== null) expect([v.ord, got[v.ord - 1]]).toEqual([v.ord, v.value]);
    expect(got[dateMap.ord - 1]).toBe('2026-03-10');
    expect(ws.getRow(rows.get(sebha.code)!).getCell(dateMap.ord).value).toBeInstanceOf(Date);
    expect(f.book!.getWorksheet('Export Info')).toBeDefined();

    // audit rows: start (parts), done (row counts) and download
    const audit = (await db.query(`SELECT action, after FROM audit_log WHERE entity_type = 'master_export' AND entity_id = $1 ORDER BY id`, [start.body.id])).rows;
    expect(audit.map((x: { action: string }) => x.action)).toEqual(['master_export.start', 'master_export.done', 'master_export.download']);
    expect(audit[0].after).toMatchObject({ kind: 'full', parts: ['sites', 'milestones', 'tasks'] });
    expect(audit[1].after.row_count).toBe(e.row_count);
    expect(audit[2].after).toMatchObject({ export_id: start.body.id, row_count: e.row_count });

    // nobody else downloads it, nobody else lists it
    const other = await actor(app, db, { regions: [7], grants: EXPORTER });
    expect((await fetchBook(other.api, start.body.id)).status).toBe(404);
    expect((await other.api.call('get', '/exports/master')).body.items.map((x: { id: string }) => x.id)).not.toContain(start.body.id);
    const admin = await plainAdmin(app, db, false);
    expect((await fetchBook(admin.api, start.body.id)).status).toBe(404);
  });

  it('a System Admin export of chosen regions holds the sites of both regions', async () => {
    const admin = await plainAdmin(app, db, false);
    const start = await admin.api.call('post', '/exports/master', { parts: ['sites'], regions: [6, 7] });
    expect(start.status).toBe(202);
    const e = await finished(admin.api, start.body.id);
    expect(e).toMatchObject({ status: 'done', kind: 'partial', parts: ['sites'], regions: [6, 7] });
    const f = await fetchBook(admin.api, start.body.id);
    expect(f.headers['content-disposition']).toMatch(/GSDN_Sites_\d{8}\.xlsx/);
    const ws = f.book!.getWorksheet('Master')!;
    const rows = siteRows(ws, 5);
    expect(rows.has(gm.code)).toBe(true);
    expect(rows.has(sebha.code)).toBe(true);
    // a part not chosen keeps its columns (layout) but stays empty: the task date column is the tasks part
    expect(text(ws.getRow(rows.get(sebha.code)!).getCell(dateMap.ord).value)).toBeNull();
    expect(text(ws.getRow(rows.get(sebha.code)!).getCell(6).value)).toBe('South');
  });

  it('"export current view" of the Sites list applies the list filters (F3 filter tree included) and the chosen columns', async () => {
    const a = await actor(app, db, { regions: [7], grants: EXPORTER });
    const tree = { op: 'and', items: [{ field: 'site_code', operator: 'contains', value: `MX${TAG}` }] };
    const start = await a.api.call('post', '/exports/master', {
      view: { source: 'sites', filters: { overall_status: 'on_hold', filter: JSON.stringify(tree) }, columns: ['site_code', 'region', 'overall_status', 'current_stage'] },
    });
    expect(start.status).toBe(202);
    const e = await finished(a.api, start.body.id);
    expect(e).toMatchObject({ status: 'done', kind: 'view', parts: [], row_count: 1 });
    expect(e.view.columns).toEqual(['site_code', 'region', 'overall_status', 'current_stage']);
    const ws = (await fetchBook(a.api, start.body.id)).book!.getWorksheet('Master')!;
    expect(rowValues(ws, 3, 4)).toEqual(['Site ID', 'Region', 'Overall Status', 'Current Stage']);
    expect(rowValues(ws, 5, 3)).toEqual([sebha.code, 'Sebha', 'on_hold']);
    expect(text(ws.getRow(6).getCell(1).value)).toBeNull();
    const audit = (await db.query(`SELECT after FROM audit_log WHERE action = 'master_export.start' AND entity_id = $1`, [start.body.id])).rows[0].after;
    expect(audit.view.filters).toMatchObject({ overall_status: 'on_hold' });
  });

  it('"export current view" of a register writes its sheet in the Master layout with the list filters, limited to the export regions', async () => {
    const t = await team(app, db, 'gecol', 'gecol', 7);
    const rec = await createRec(t, { ...GECOL, contractor: `Synthetic Power ${TAG}` });
    expect(rec.state).toBeDefined();
    const a = await actor(app, db, { regions: [7], grants: [...G('gecol', 'view', 'export')] });
    const start = await a.api.call('post', '/exports/master', { view: { source: 'gecol', filters: { site_id: t.site.id }, columns: ['site_code', 'pr_no', 'contractor', 'state'] } });
    expect(start.status).toBe(202);
    const e = await finished(a.api, start.body.id);
    expect(e).toMatchObject({ status: 'done', row_count: 1 });
    const ws = (await fetchBook(a.api, start.body.id)).book!.getWorksheet('GECOL')!;
    expect(rowValues(ws, 1, 4)).toEqual(['Site ID', 'GECOL PR No.', 'GECOL Contractor', 'State']);
    expect(rowValues(ws, 3, 3)).toEqual([t.site.code, 'GP-1', `Synthetic Power ${TAG}`]);
    // a Tripoli-only exporter of GECOL sees nothing of Sebha
    const tri = await actor(app, db, { regions: [1], grants: [...G('gecol', 'view', 'export')] });
    const s2 = await tri.api.call('post', '/exports/master', { parts: ['gecol'] });
    expect(s2.status).toBe(202);
    const e2 = await finished(tri.api, s2.body.id);
    const ws2 = (await fetchBook(tri.api, s2.body.id)).book!.getWorksheet('GECOL')!;
    const codes: string[] = [];
    ws2.eachRow((row, n) => { if (n >= 3) codes.push(String(row.getCell(2).value)); });
    expect(codes).not.toContain(t.site.code);
    expect(e2.status).toBe('done');
  });
});

describe('the five registers with no Master columns (contract 0.15.310)', () => {
  const FIVE = ['car_dispatcher', 'financial_advances', 'incidents', 'lessons_learned', 'invoices'];
  const SHEETS: Record<string, string> = { car_dispatcher: 'Car Dispatcher', financial_advances: 'Financial Advances', incidents: 'Incidents', lessons_learned: 'Lessons Learned', invoices: 'Invoices' };

  it('a System Admin export writes one sheet per register; the grant and the regions follow the register\'s own module', async () => {
    const inv = await team(app, db, 'invoices', 'invoices', 7);
    const rec = await createRec(inv, { invoice_no: `INV-${TAG}`, invoice_date: '2026-11-20', amount: 1500 });
    expect(rec.state).toBeDefined();
    const inc = await team(app, db, 'incidents', 'incidents', 7);
    await createRec(inc, { incident_date: '2026-11-20', incident_type: 'Theft', severity: 'Major', description: `Cable theft ${TAG}`, injured_count: 0 });
    const admin = await plainAdmin(app, db, false);
    const start = await admin.api.call('post', '/exports/master', { parts: FIVE, regions: [7] });
    expect(start.status).toBe(202);
    const e = await finished(admin.api, start.body.id);
    expect(e.status).toBe('done');
    const book = (await fetchBook(admin.api, start.body.id)).book!;
    for (const k of FIVE) expect(book.getWorksheet(SHEETS[k]!), k).toBeDefined();
    const flat = (ws: ExcelJS.Worksheet): string => { const out: string[] = []; ws.eachRow((row) => out.push(JSON.stringify(row.values))); return out.join('\n'); };
    expect(flat(book.getWorksheet('Invoices')!)).toContain(`INV-${TAG}`);
    expect(flat(book.getWorksheet('Incidents')!)).toContain(`Cable theft ${TAG}`);

    // an exporter of Invoices only: the other four are refused, the Invoices sheet holds only the export regions
    const only = await actor(app, db, { regions: [7], grants: [['invoices', 'view'], ['invoices', 'export']] });
    expect((await only.api.call('post', '/exports/master', { parts: ['incidents'] })).status).toBe(403);
    const ok = await only.api.call('post', '/exports/master', { parts: ['invoices'] });
    expect(ok.status).toBe(202);
    await finished(only.api, ok.body.id);
    const mine = (await fetchBook(only.api, ok.body.id)).book!;
    expect(flat(mine.getWorksheet('Invoices')!)).toContain(`INV-${TAG}`);
    const tri = await actor(app, db, { regions: [1], grants: [['invoices', 'view'], ['invoices', 'export']] });
    const t2 = await tri.api.call('post', '/exports/master', { parts: ['invoices'] });
    expect(t2.status).toBe(202);
    await finished(tri.api, t2.body.id);
    expect(flat((await fetchBook(tri.api, t2.body.id)).book!.getWorksheet('Invoices')!)).not.toContain(`INV-${TAG}`);
  });

  it('"export current view" of Invoices works with its own columns', async () => {
    const inv = await team(app, db, 'invoices', 'invoices', 7);
    await createRec(inv, { invoice_no: `INV-V${TAG}`, invoice_date: '2026-11-21', amount: 20 });
    const a = await actor(app, db, { regions: [7], grants: [['invoices', 'view'], ['invoices', 'export']] });
    const start = await a.api.call('post', '/exports/master', { view: { source: 'invoices', filters: { site_id: inv.site.id }, columns: ['site_code', 'invoice_no'] } });
    expect(start.status).toBe(202);
    const e = await finished(a.api, start.body.id);
    expect(e).toMatchObject({ status: 'done', row_count: 1 });
  });
});
