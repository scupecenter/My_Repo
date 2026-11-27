import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, superDb } from './helpers';
import { downloadTemplate, load } from './tpl-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * Hardening layer 3b (migration 0564): the template TPL-DAILY-PLAN and POST /daily-plans/import. Region 4, one fixed past working day (Sunday 2025-06-22),
 * synthetic sites only. The import goes through the doors of the screen, so the rights, the lock and the audit are the ones of the screen.
 */
const REGION = 4;
const D = '2025-06-22';
const PREFIX = `DT${randomBytes(3).toString('hex').toUpperCase()}`;
type J = Record<string, any>;
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let l1: Actor;
let l2: Actor;
let plain: Actor;
let s1: { id: string; code: string };
let s2: { id: string; code: string };
let s3: { id: string; code: string };

async function site(region: number): Promise<{ id: string; code: string }> {
  const code = `${PREFIX}-${randomBytes(2).toString('hex').toUpperCase()}`;
  const wf = await db.query('SELECT id FROM workflow_definitions WHERE version = 1');
  const r = await db.query(
    `INSERT INTO sites (site_code, owner_site_id, name, region_id, workflow_version_id, delivery_scenario, overall_status, tower_owner, latitude, longitude, site_type,
       scope_tower_erection, scope_te_full, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'new_build', 'in_progress', 'Tower Co (synthetic)', 32.1, 20.05, 'Greenfield', 'yes'::"ScopeFlag", 'yes'::"ScopeFlag", now()) RETURNING id`,
    [code, `OWN-${code}`, `Site ${code}`, region, wf.rows[0].id]);
  return { id: r.rows[0].id as string, code };
}
async function cell(level: 1 | 3, userId: string): Promise<void> {
  const c = await db.query(`INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ('daily_plan', $1, 'any_one', $2, false, now()) RETURNING id`, [level, REGION]);
  await db.query(`INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, 'user', $2)`, [c.rows[0].id, userId]);
}
async function planned(s: { id: string }, date: string): Promise<void> {
  const td = await db.query(`SELECT id FROM task_definitions WHERE code = 'B5'`);
  await db.query(`INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, planned_date, level_opened_at, level_round, updated_at)
    VALUES ($1, $2, $3, 'open'::"TaskState", 1, 2, $4, now(), 1, now())`, [s.id, REGION, td.rows[0].id, date]);
}
const get = (a: Actor, date = D) => a.api.call('get', `/daily-plans?date=${date}&region_id=${REGION}`);
const rowOf = (body: J, id: string): J | undefined => (body.rows as J[]).find((r) => r.site_id === id);
const upload = (a: Actor, file: Buffer) => a.api.call('post', '/daily-plans/import').attach('file', file, 'daily-plan.xlsx');
const tplFile = async (a: Actor, query: string): Promise<Buffer> => {
  const r = await downloadTemplate(a.api, 'TPL-DAILY-PLAN', query);
  expect(r.status).toBe(200);
  return r.buffer;
};
/** The Data sheet as [header -> column] and the row of a site. */
async function edit(buf: Buffer, change: (data: ExcelJS.Worksheet, col: (h: string) => number, rowOf: (code: string) => number) => void, extra?: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = await load(buf);
  const data = wb.getWorksheet('Data')!;
  const col = (h: string): number => { for (let c = 1; c <= data.columnCount; c++) if (data.getRow(1).getCell(c).text === h) return c; throw new Error(`no column ${h}`); };
  const rowFor = (code: string): number => { for (let r = 2; r <= data.rowCount; r++) if (data.getRow(r).getCell(col('Site ID')).text === code) return r; return -1; };
  change(data, col, rowFor);
  extra?.(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  const grants: [string, string][] = [['sites', 'view'], ['sites', 'edit'], ['templates', 'download_documents']];
  l1 = await actor(app, db, { level: 'entry', regions: [REGION], grants });
  l2 = await actor(app, db, { level: 'approve', regions: [REGION], grants });
  plain = await actor(app, db, { level: 'entry', regions: [REGION], grants: [['approvals', 'view']] });
  await cell(1, l1.user.id);
  await cell(3, l2.user.id);
  s1 = await site(REGION);
  s2 = await site(REGION);
  s3 = await site(REGION);
  await planned(s1, D);
  await planned(s2, D);
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe('TPL-DAILY-PLAN download', () => {
  it('is listed for who sees the Daily Plan, refused to who does not, and the pre-filled copy carries the plan of the day', async () => {
    const list = await l1.api.call('get', '/templates');
    expect(list.body.items.find((t: J) => t.template_id === 'TPL-DAILY-PLAN')).toMatchObject({ template_kind: 'daily_plan', current_version: 1 });
    expect((await plain.api.call('get', '/templates')).body.items.find((t: J) => t.template_id === 'TPL-DAILY-PLAN')).toBeUndefined();
    expect((await downloadTemplate(plain.api, 'TPL-DAILY-PLAN')).status).toBe(404);
    const blank = await load(await tplFile(l1, ''));
    expect(blank.getWorksheet('Data')!.getRow(2).getCell(2).text).toBe('');
    const wb = await load(await tplFile(l1, `?date=${D}&region_id=${REGION}`));
    const data = wb.getWorksheet('Data')!;
    const codes = [...Array(data.rowCount - 1)].map((_, i) => data.getRow(i + 2).getCell(2).text);
    expect(codes).toContain(s1.code);
    expect(codes).toContain(s2.code);
    expect(codes).not.toContain(s3.code);
  });
});

describe('POST /daily-plans/import', () => {
  it('applies manual values, reason and remark, adds and removes a site, and writes the audit; an unchanged file changes nothing', async () => {
    const v0 = (await get(l1)).body.plans[0].version as number;
    const f = await edit(await tplFile(l1, `?date=${D}&region_id=${REGION}`), (data, col, rowFor) => {
      data.getRow(rowFor(s1.code)).getCell(col('Planned Work')).value = 'Hand-written plan (import)';
      data.getRow(rowFor(s1.code)).getCell(col('Remark')).value = 'from the file';
      data.getRow(rowFor(s1.code)).getCell(col('Reason (if not reach target)')).value = 'Rain stopped the crew'; // a row below target needs its reason
      const r2 = rowFor(s2.code);
      data.getRow(r2).getCell(col('Remove from plan (yes)')).value = 'yes';
      const n = data.rowCount + 1;
      data.getRow(n).getCell(col('Plan date (YYYY-MM-DD)')).value = D;
      data.getRow(n).getCell(col('Site ID')).value = s3.code;
      data.getRow(n).getCell(col('Planned Work')).value = 'Added by file';
      data.getRow(n).getCell(col('Reason (if not reach target)')).value = 'Not started yet';
    });
    const res = await upload(l1, f);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ template_id: 'TPL-DAILY-PLAN', template_version: 1, status: 'applied', updated: 2, added: 1, removed: 1 });
    const day = (await get(l1)).body;
    expect(rowOf(day, s1.id)).toMatchObject({ remark: 'from the file', values: { planned_work: 'Hand-written plan (import)' }, overridden: ['planned_work'] });
    expect(rowOf(day, s2.id)).toBeUndefined();
    expect(rowOf(day, s3.id)).toMatchObject({ origin: 'added', values: { planned_work: 'Added by file' } });
    expect(day.plans[0].version).toBeGreaterThan(v0);
    const audit = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'daily_plan.template_import' AND after ->> 'file_name' = 'daily-plan.xlsx' AND actor_id = $1`, [l1.user.id]);
    expect(audit.rows[0].n).toBe(1);
    // the same file as downloaded now changes nothing
    const again = await upload(l1, await tplFile(l1, `?date=${D}&region_id=${REGION}`));
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ updated: 0, added: 0, removed: 0 });
  });

  it('refuses the whole file when one row is refused, and applies nothing', async () => {
    const before = rowOf((await get(l1)).body, s1.id)!;
    const f = await edit(await tplFile(l1, `?date=${D}&region_id=${REGION}`), (data, col, rowFor) => {
      data.getRow(rowFor(s1.code)).getCell(col('Planned Work')).value = 'must not be saved';
      const n = data.rowCount + 1;
      data.getRow(n).getCell(col('Plan date (YYYY-MM-DD)')).value = D;
      data.getRow(n).getCell(col('Site ID')).value = 'NO-SUCH-SITE';
    });
    const res = await upload(l1, f);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.errors.some((e: J) => /^\/rows\/\d+\/site_code$/.test(e.path) && e.code === 'not_found')).toBe(true);
    expect(rowOf((await get(l1)).body, s1.id)!.values.planned_work).toBe(before.values.planned_work);
  });

  it('a viewer without the entry level is refused per row, and a locked day refuses the file', async () => {
    const f = await edit(await tplFile(l2, `?date=${D}&region_id=${REGION}`), (data, col, rowFor) => {
      data.getRow(rowFor(s1.code)).getCell(col('Remark')).value = 'by the approver';
    });
    const denied = await upload(l2, f);
    expect(denied.status).toBe(422);
    expect(denied.body.errors[0].code).toBe('action_forbidden');
    // lock the day (the approver, no row is below target), then the L1 file is refused
    const v = `"${(await get(l1)).body.plans[0].version}"`;
    const lock = await l2.api.call('post', `/daily-plans/${D}/regions/${REGION}/lock`, undefined, { 'If-Match': v });
    expect(lock.status, JSON.stringify(lock.body)).toBe(200);
    const g = await edit(await tplFile(l1, `?date=${D}&region_id=${REGION}`), (data, col, rowFor) => {
      data.getRow(rowFor(s1.code)).getCell(col('Remark')).value = 'after the lock';
    });
    const locked = await upload(l1, g);
    expect(locked.status).toBe(422);
    expect(locked.body.errors[0].code).toBe('plan_locked');
  });

  it('rejects a file of another template or an old header, and a request without the file', async () => {
    const tampered = await edit(await tplFile(l1, ''), (data, col) => { data.getRow(1).getCell(col('Remark')).value = 'Remarks'; });
    const r1 = await upload(l1, tampered);
    expect(r1.status).toBe(422);
    expect(r1.body.code).toBe('template_rejected');
    const wrong = await edit(await tplFile(l1, ''), () => undefined, (wb) => { wb.getWorksheet('_tpl')!.eachRow((row) => { if (row.getCell(1).text === 'template_id') row.getCell(2).value = 'TPL-HOLIDAYS'; }); });
    const r2 = await upload(l1, wrong);
    expect(r2.status).toBe(422);
    expect(r2.body.code).toBe('template_rejected');
    expect((await l1.api.call('post', '/daily-plans/import')).status).toBe(422);
    expect((await upload(admin, Buffer.from('not a workbook'))).status).toBe(422);
  });
});

describe('the sub-stream templates the inventory asked about', () => {
  it('TPL-PERMITS (one template for every permit stream) and TPL-HLC are listed, versioned and download', async () => {
    const list = (await admin.api.call('get', '/templates')).body.items as J[];
    for (const id of ['TPL-PERMITS', 'TPL-HLC']) expect(list.find((t) => t.template_id === id), id).toMatchObject({ template_kind: 'register', current_version: expect.any(Number) });
    for (const id of ['TPL-PERMITS', 'TPL-HLC']) expect((await downloadTemplate(admin.api, id)).status, id).toBe(200);
    // the permit type column lists every active type, so a row of each stream (CW, TE, ACQ, OM) can be typed in the one template
    const cols = (await db.query(`SELECT v.columns FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-PERMITS' AND v.is_current`)).rows[0].columns as J[];
    const typeCol = cols.find((c) => /permit_type/.test(String(c.code)));
    expect(typeCol, 'permit type column').toBeTruthy();
    const options = (typeCol!.options ?? []) as string[];
    const types = (await db.query(`SELECT code FROM permit_types WHERE is_active`)).rows.map((r) => r.code as string);
    expect(types.length).toBeGreaterThan(0);
    for (const t of types) expect(options.some((o) => o === t || o.includes(t)), t).toBe(true);
  });
});
