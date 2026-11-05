import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import type { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, beginAs, delegate, loggedIn, makeUser, startApp, superDbHw } from './helpers';
import { JobRunsService } from '../src/logs/job-runs.service';
import { G } from './reg-helpers';
import { day, uploadFile } from './tpl-helpers';
import { SITE_APPROVE_GRANTS, filled } from './tpl-stream-helpers';
import { PDF, slotOf, slots, upload } from './doc-helpers';
import { Actor, Site, actor, makeSite, makeTask, plainAdmin, setCell } from './wf-helpers';

/**
 * Migration 0073 (decision on owner question Q462): the one-time historical-load document waiver, on the sixth-style database of this suite (the seeded Document
 * Library is active, so B6 "Layout submission" needs its layout document). Region 4 is used for the tasks; the System Admin holds L1 of the tasks (a cell), a separate
 * approver holds L2. Dates are fixed past dates; the cutoff date is 2026-01-31.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 4;
const CUTOFF = '2026-01-31';
const BEFORE = '2026-01-10';
const AFTER = '2026-03-10';
const REASON = 'One-time load of the historical tasks of the owner Master';

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_HW as string });
  db = await superDbHw();
});
afterAll(async () => {
  await db.end();
  await app.close();
});
// the waiver is one row of the settings table: every test starts closed (the superuser may write it; nobody else can)
beforeEach(async () => {
  await db.query(`UPDATE settings SET value = '{"open": false, "cutoff_date": null}'::jsonb WHERE key = 'load.historical_waiver'`);
});

const OPEN_BODY = { open: true, cutoff_date: CUTOFF, reason: 'Open for the one-time load of the Master' };
const openWaiver = (a: Actor, over: Record<string, unknown> = {}) => a.api.call('put', '/settings/historical-waiver', { ...OPEN_BODY, ...over });
const closeWaiver = (a: Actor) => a.api.call('put', '/settings/historical-waiver', { open: false, reason: 'The load is finished' });
const audit = (action: string, entityId?: string) =>
  q<{ id: number; before: Record<string, any> | null; after: Record<string, any> | null; reason: string | null; is_admin_override: boolean; actor_id: string | null; batch_id: string | null }>(
    db, `SELECT id, before, after, reason, is_admin_override, actor_id, batch_id FROM audit_log WHERE action = $1 ${entityId ? 'AND entity_id = $2' : ''} ORDER BY id`, entityId ? [action, entityId] : [action]);

interface Team { admin: Actor; approver: Actor; codes: string[] }
/** A System Admin who is the L1 holder (a matrix cell) of the tasks in region 4, and an approver who is the L2 holder. */
async function team(codes: string[] = ['B6', 'B8'], region = R): Promise<Team> {
  const admin = await plainAdmin(app, db);
  const approver = await actor(app, db, { level: 'approve', grants: SITE_APPROVE_GRANTS, regions: [region], modules: null });
  for (const c of codes) {
    await setCell(db, c, region, 'entry', { user: [admin.user.id] });
    await setCell(db, c, region, 'approve', { user: [approver.user.id] });
  }
  return { admin, approver, codes };
}
/** A site with its tasks open in region 4. */
async function siteWith(codes: string[], region = R): Promise<{ site: Site; tasks: Record<string, string> }> {
  const site = await makeSite(db, region, { prefix: 'HW' });
  const tasks: Record<string, string> = {};
  for (const c of codes) tasks[c] = await makeTask(db, site, c, 'open');
  return { site, tasks };
}
const taskFlag = async (id: string) => (await q<{ state: string; f: boolean; batch: string | null; miss: string[] | null; cleared: Date | null; version: number }>(
  db, `SELECT state::text AS state, historical_no_documents AS f, historical_batch_id::text AS batch, historical_missing AS miss, historical_cleared_at AS cleared, version FROM task_instances WHERE id = $1`, [id]))[0]!;
const rowsOf = async (api: Api, id: string): Promise<Record<string, any>[]> => {
  const res = await api.call('get', `/import-batches/${id}/rows`);
  expect(res.status).toBe(200);
  return res.body.items;
};
const upl = async (a: Actor, rows: Record<string, ExcelJS.CellValue>[], fields: Record<string, string> = {}) => {
  const buf = await filled(a.api, 'TPL-SITE-CW', rows);
  return uploadFile(a.api, buf, 'filled.xlsx', fields);
};
const send = (a: Actor, batch: { id: string; version: number }) => a.api.call('post', `/import-batches/${batch.id}/submit`, undefined, { 'If-Match': `"${batch.version}"` });

describe('the waiver setting: who opens and closes it, and how', () => {
  it('is closed by default, readable by any signed-in user, and shows the reason and the opener to a System Admin only', async () => {
    const t = await team();
    const user = await actor(app, db, { grants: [['sites', 'view']], regions: [R], modules: null });
    const cold = await user.api.call('get', '/settings/historical-waiver');
    expect(cold.status).toBe(200);
    expect(cold.body).toMatchObject({ open: false, cutoff_date: null, expires_at: null, window_days: 30, can_manage: false });
    expect((await t.admin.api.call('get', '/settings/historical-waiver')).body).toMatchObject({ open: false, can_manage: true });
    expect(await q(db, `SELECT value FROM settings WHERE key = 'load.historical_waiver'`)).toEqual([{ value: { open: false, cutoff_date: null } }]);

    const open = await openWaiver(t.admin);
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ open: true, cutoff_date: CUTOFF, window_days: 30, days_left: 30, reason: OPEN_BODY.reason, opened_by: t.admin.user.id, can_manage: true });
    const seen = (await user.api.call('get', '/settings/historical-waiver')).body;
    expect(seen).toMatchObject({ open: true, cutoff_date: CUTOFF, can_manage: false, opened_by: null, reason: null });
    const days = (new Date(seen.expires_at).getTime() - new Date(seen.opened_at).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
  });

  it('is opened and closed by a System Admin only, with a step-up, a reason and a cutoff date that is not in the future; a delegate and a settings editor are refused', async () => {
    const t = await team();
    // a delegate holding every right of the settings screens and of the templates is still not a System Admin
    const dg = await makeUser(db, { assigned: true });
    await delegate(db, dg.id, [['admin.settings', 'view'], ['admin.settings', 'edit'], ['admin.settings', 'administer'], ['templates', 'administer'], ['templates', 'import']]);
    const dgApi = await loggedIn(app, dg);
    expect((await dgApi.stepUp(dg.password)).status).toBe(200);
    const refusedDelegate = await dgApi.call('put', '/settings/historical-waiver', OPEN_BODY);
    expect(refusedDelegate.status).toBe(403);
    expect(refusedDelegate.body).toMatchObject({ code: 'action_forbidden' });
    const editor = await actor(app, db, { grants: [...G('admin.settings', 'view', 'edit', 'administer')], regions: null, modules: null });
    expect((await editor.api.call('put', '/settings/historical-waiver', OPEN_BODY)).status).toBe(403);
    expect((await q(db, `SELECT value FROM settings WHERE key = 'load.historical_waiver'`))[0]!.value).toEqual({ open: false, cutoff_date: null });

    // a System Admin without a fresh step-up
    const cold = await plainAdmin(app, db, false);
    const noStep = await cold.api.call('put', '/settings/historical-waiver', OPEN_BODY);
    expect(noStep.status).toBe(401);
    expect(noStep.body).toMatchObject({ code: 'step_up_required' });

    // validation: reason, cutoff date required, not in the future, unknown fields
    const today = (await q<{ d: string }>(db, 'SELECT (cal_today() + 1)::text AS d'))[0]!.d;
    const bad = async (body: Record<string, unknown>) => (await t.admin.api.call('put', '/settings/historical-waiver', body));
    expect((await bad({ open: true, cutoff_date: CUTOFF })).status).toBe(422);                              // no reason
    expect((await bad({ open: true, reason: 'No cutoff date given' })).status).toBe(422);                    // no cutoff
    const future = await bad({ open: true, cutoff_date: today, reason: 'Cutoff in the future' });
    expect(future.status).toBe(422);
    expect(future.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/cutoff_date', code: 'in_the_future' })]));
    expect((await bad({ ...OPEN_BODY, days: 90 })).status).toBe(422);                                         // unknown key
    expect((await q(db, `SELECT value FROM settings WHERE key = 'load.historical_waiver'`))[0]!.value).toEqual({ open: false, cutoff_date: null });

    // open, then open again (409), close, close again (409)
    const before = (await audit('historical_waiver.open')).length;
    expect((await openWaiver(t.admin)).status).toBe(200);
    expect((await openWaiver(t.admin, { cutoff_date: '2026-02-15' })).status).toBe(409);
    const closed = await closeWaiver(t.admin);
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ open: false, cutoff_date: null, closed_how: 'manual' });
    expect((await closeWaiver(t.admin)).status).toBe(409);

    // every change is audited with before and after values and the admin-override flag
    const opens = await audit('historical_waiver.open');
    expect(opens).toHaveLength(before + 1);
    expect(opens.at(-1)).toMatchObject({ is_admin_override: true, actor_id: t.admin.user.id, reason: OPEN_BODY.reason,
      before: { open: false }, after: { open: true, cutoff_date: CUTOFF, opened_by: t.admin.user.id } });
    const shut = (await audit('historical_waiver.close')).at(-1)!;
    expect(shut).toMatchObject({ is_admin_override: true, actor_id: t.admin.user.id, reason: 'The load is finished', before: { open: true, cutoff_date: CUTOFF }, after: { open: false, closed_how: 'manual' } });
  });

  it('closes itself after 30 days: the state is closed at once, the job writes and audits it, and a batch marked before can no longer skip the documents', async () => {
    const t = await team(['B6']);
    const s = await siteWith(['B6']);
    expect((await openWaiver(t.admin)).status).toBe(200);
    const up = await upl(t.admin, [{ 'Site ID': s.site.code, 'B6 Actual Date': day(BEFORE) }], { historical_load_reason: REASON });
    expect(up.status).toBe(202);
    expect(up.body.historical_load).toMatchObject({ cutoff_date: CUTOFF, reason: REASON, marked_by: { id: t.admin.user.id } });

    // 30 days pass: the stored row still says open, the effective state does not
    await db.query(`UPDATE settings SET value = jsonb_set(value, '{expires_at}', to_jsonb(now() - interval '1 minute')) WHERE key = 'load.historical_waiver'`);
    const state = (await t.admin.api.call('get', '/settings/historical-waiver')).body;
    expect(state).toMatchObject({ open: false, cutoff_date: null });
    expect((await q(db, `SELECT value ->> 'open' AS o FROM settings WHERE key = 'load.historical_waiver'`))[0]!.o).toBe('true');
    // the job writes the closing and audits it, once
    expect(await app.get(JobRunsService).expireHistoricalWaiver()).toBe(1);
    expect(await app.get(JobRunsService).expireHistoricalWaiver()).toBe(0);
    const stored = (await q<{ value: Record<string, unknown> }>(db, `SELECT value FROM settings WHERE key = 'load.historical_waiver'`))[0]!.value;
    expect(stored).toMatchObject({ open: false, cutoff_date: null, closed_how: 'expired', last_cutoff_date: CUTOFF });
    const exp = (await audit('historical_waiver.expired')).at(-1)!;
    expect(exp).toMatchObject({ actor_id: null, is_admin_override: true, before: { open: true, cutoff_date: CUTOFF }, after: { open: false, closed_how: 'expired' } });
    expect((await t.admin.api.call('get', '/settings/historical-waiver')).body).toMatchObject({ open: false, closed_how: 'expired' });

    // the batch was marked under that waiver, but the waiver is over: sending it skips nothing
    const sent = await send(t.admin, up.body);
    expect(sent.status).toBe(200);
    expect(sent.body.outcome.failed).toHaveLength(1);
    expect(sent.body.outcome.failed[0]).toMatchObject({ code: 'mandatory_slots_missing' });
    expect((await taskFlag(s.tasks.B6!)).f).toBe(false);
    // a new batch can no longer be marked
    const s2 = await siteWith(['B6']);
    const late = await upl(t.admin, [{ 'Site ID': s2.site.code, 'B6 Actual Date': day(BEFORE) }], { historical_load_reason: REASON });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: 'invalid_transition' });
  });

  it('opens again after it closed itself (the closing is written first), with a new window', async () => {
    const t = await team(['B6']);
    expect((await openWaiver(t.admin)).status).toBe(200);
    await db.query(`UPDATE settings SET value = jsonb_set(value, '{expires_at}', to_jsonb(now() - interval '1 hour')) WHERE key = 'load.historical_waiver'`);
    const again = await openWaiver(t.admin, { cutoff_date: '2026-02-15' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ open: true, cutoff_date: '2026-02-15', days_left: 30 });
    expect((await audit('historical_waiver.expired')).length).toBeGreaterThan(0);
  });
});

describe('a stream-template batch marked "historical load: accept without documents"', () => {
  it('approves the row whose actual date is on or before the cutoff without documents and flags it; the row after the cutoff is still refused; every other check runs', async () => {
    const t = await team();
    const a = await siteWith(['B6']);
    const b = await siteWith(['B6']);
    const c = await siteWith(['B6']);
    expect((await openWaiver(t.admin)).status).toBe(200);

    const up = await upl(t.admin, [
      { 'Site ID': a.site.code, 'B6 Actual Date': day(BEFORE) },
      { 'Site ID': b.site.code, 'B6 Actual Date': day(AFTER) },
      { 'Site ID': c.site.code, 'B6 Actual Date': day(CUTOFF) },        // the cutoff date itself is "on or before"
    ], { historical_load_reason: REASON });
    expect(up.status).toBe(202);
    expect(up.body.historical_load).toMatchObject({ cutoff_date: CUTOFF, reason: REASON });
    const rows = await rowsOf(t.admin.api, up.body.id);
    const rowOf = (code: string) => rows.find((r) => r.site_code === code)!;
    expect(rowOf(a.site.code)).toMatchObject({ action: 'update' });
    expect(rowOf(a.site.code).warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'historical_no_documents' })]));
    expect(rowOf(a.site.code).errors).toEqual([]);
    expect(rowOf(b.site.code)).toMatchObject({ action: 'error' });
    expect(rowOf(b.site.code).errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'mandatory_slots_missing' })]));
    expect(rowOf(c.site.code)).toMatchObject({ action: 'update' });
    // the batch carries the mark; the audit says who, why and under which cutoff
    const mark = (await audit('import_batch.historical_load', up.body.id))[0]!;
    expect(mark).toMatchObject({ is_admin_override: true, actor_id: t.admin.user.id, reason: REASON, before: { historical_load: false }, after: { historical_load: true, cutoff_date: CUTOFF } });

    // the System Admin (the uploader) sends it: the rows go to L2 as the task screen would
    const sent = await send(t.admin, up.body);
    expect(sent.status).toBe(200);
    expect(sent.body.outcome.submitted).toBe(2);
    const fa = await taskFlag(a.tasks.B6!);
    expect(['in_review', 'in_approval']).toContain(fa.state);
    expect(fa).toMatchObject({ f: true, batch: up.body.id });
    expect(fa.miss).toEqual(['B6']);
    expect((await taskFlag(c.tasks.B6!)).f).toBe(true);
    expect((await taskFlag(b.tasks.B6!)).f).toBe(false);
    expect((await taskFlag(b.tasks.B6!)).state).toBe('open');

    // the flag audit: before and after values, the batch and the row, the admin-override flag
    const fl = (await audit('task_historical_no_documents', a.tasks.B6))[0]!;
    expect(fl).toMatchObject({ is_admin_override: true, actor_id: t.admin.user.id, reason: REASON,
      before: { historical_no_documents: false, missing_documents: ['B6'] }, after: { historical_no_documents: true, missing_documents: ['B6'], batch_id: up.body.id, cutoff_date: CUTOFF, actual_date: BEFORE } });
    expect(fl.after!.batch_row_id).toBeTruthy();

    // the task shows the badge in the grid, the detail and the history
    const detail = (await t.admin.api.call('get', `/tasks/${a.tasks.B6}`)).body;
    expect(detail).toMatchObject({ historical_no_documents: true, historical_load: { batch_id: up.body.id, cutoff_date: CUTOFF, missing_documents: ['B6'], reason: REASON } });
    const stages = (await t.admin.api.call('get', `/sites/${a.site.id}/tasks`)).body.stages as { tasks: { task_code: string; historical_no_documents: boolean }[] }[];
    const grid = stages.flatMap((st) => st.tasks).find((x) => x.task_code === 'B6');
    expect(grid).toMatchObject({ historical_no_documents: true });
    expect((await t.admin.api.call('get', `/tasks/${b.tasks.B6}`)).body).toMatchObject({ historical_no_documents: false, historical_load: null });

    // L2 decides as for any batch; the approved task keeps the flag
    const dec = await t.approver.api.call('post', `/import-batches/${up.body.id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': `"${sent.body.version}"` });
    expect(dec.status).toBe(200);
    expect((await taskFlag(a.tasks.B6!))).toMatchObject({ state: 'approved', f: true });
  });

  it('refuses an unmarked batch: the same row with the same date is an error row, and nothing is flagged', async () => {
    const t = await team();
    const a = await siteWith(['B6']);
    expect((await openWaiver(t.admin)).status).toBe(200);                      // the waiver is open, but this batch is not marked
    const up = await upl(t.admin, [{ 'Site ID': a.site.code, 'B6 Actual Date': day(BEFORE) }]);
    expect(up.status).toBe(202);
    expect(up.body.historical_load).toBeNull();
    const row = (await rowsOf(t.admin.api, up.body.id))[0]!;
    expect(row).toMatchObject({ action: 'error' });
    expect(row.errors[0]).toMatchObject({ code: 'mandatory_slots_missing' });
    expect(row.warnings).toEqual([]);
    expect((await taskFlag(a.tasks.B6!)).f).toBe(false);
    expect(await q(db, `SELECT 1 FROM import_batches WHERE id = $1 AND historical_load`, [up.body.id])).toHaveLength(0);
  });

  it('refuses the mark to anyone but a System Admin with a step-up, while the waiver is open, in submit mode, for a stream template', async () => {
    const t = await team();
    const a = await siteWith(['B6']);
    const rows = [{ 'Site ID': a.site.code, 'B6 Actual Date': day(BEFORE) }];
    // closed
    const closed = await upl(t.admin, rows, { historical_load_reason: REASON });
    expect(closed.status).toBe(409);
    expect(closed.body).toMatchObject({ code: 'invalid_transition' });
    expect((await openWaiver(t.admin)).status).toBe(200);
    // a delegate with the right to import templates, and an L1 holder who is not a System Admin
    const dg = await makeUser(db, { assigned: true });
    await delegate(db, dg.id, [['templates', 'view'], ['templates', 'import'], ['templates', 'administer'], ['sites', 'view'], ['sites', 'edit'], ['admin.settings', 'edit']]);
    const dgApi = await loggedIn(app, dg);
    await dgApi.stepUp(dg.password);
    const dgActor: Actor = { user: dg, api: dgApi, roleId: '' };
    const byDelegate = await uploadFile(dgApi, await filled(t.admin.api, 'TPL-SITE-CW', rows), 'x.xlsx', { historical_load_reason: REASON });
    expect(byDelegate.status).toBe(403);
    expect(byDelegate.body).toMatchObject({ code: 'action_forbidden' });
    void dgActor;
    const l1 = await actor(app, db, { grants: [...G('sites', 'view', 'edit'), ...G('templates', 'view', 'import')], regions: [R], modules: null });
    const byHolder = await uploadFile(l1.api, await filled(t.admin.api, 'TPL-SITE-CW', rows), 'x.xlsx', { historical_load_reason: REASON });
    expect(byHolder.status).toBe(403);
    // a System Admin without a fresh step-up
    const cold = await plainAdmin(app, db, false);
    const noStep = await upl(cold, rows, { historical_load_reason: REASON });
    expect(noStep.status).toBe(401);
    expect(noStep.body).toMatchObject({ code: 'step_up_required' });
    // a draft has no document check; a register template and the Master template are not stream templates
    const draft = await upl(t.admin, rows, { historical_load_reason: REASON, mode: 'draft' });
    expect(draft.status).toBe(422);
    const noReason = await upl(t.admin, rows, { historical_load_reason: 'x' });
    expect(noReason.status).toBe(422);
    expect(await q(db, `SELECT 1 FROM import_batches WHERE historical_load AND uploaded_by = ANY($1::uuid[])`, [[dg.id, l1.user.id, cold.user.id]])).toHaveLength(0);
    expect((await taskFlag(a.tasks.B6!)).f).toBe(false);
  });

  it('keeps the other batch rules: only the System Admin who marked the batch sends it, and it is sent through the normal flow', async () => {
    const t = await team();
    const a = await siteWith(['B6']);
    expect((await openWaiver(t.admin)).status).toBe(200);
    const up = await upl(t.admin, [{ 'Site ID': a.site.code, 'B6 Actual Date': day(BEFORE) }], { historical_load_reason: REASON });
    expect(up.status).toBe(202);
    const other = await plainAdmin(app, db);
    expect((await send(other, up.body)).status).toBe(403);                      // only the uploader sends (0051)
    expect((await taskFlag(a.tasks.B6!)).f).toBe(false);
    expect((await send(t.admin, up.body)).status).toBe(200);
    expect((await taskFlag(a.tasks.B6!)).f).toBe(true);
  });
});

describe('the historical load through the P3 Master import', () => {
  type Cell = string | number | Date | { formula: string; result: unknown };
  async function masterFile(rows: Record<string, Cell>[]): Promise<Buffer> {
    const cols = await q<{ letter: string; group_top: string | null; group_mid: string | null; name: string | null }>(db, 'SELECT letter, group_top, group_mid, name FROM master_columns WHERE is_active ORDER BY ord');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Guide').getCell('A1').value = 'Guide';
    const ws = wb.addWorksheet('Master');
    for (const c of cols) {
      ws.getCell(`${c.letter}1`).value = c.group_top ?? null;
      ws.getCell(`${c.letter}2`).value = c.group_mid ?? null;
      ws.getCell(`${c.letter}3`).value = c.name ?? null;
      ws.getCell(`${c.letter}4`).value = { formula: `SUBTOTAL(3,${c.letter}5:${c.letter}504)`, result: 0 };
    }
    rows.forEach((r, i) => {
      for (const [L, v] of Object.entries(r)) {
        const cell = ws.getCell(`${L}${5 + i}`);
        cell.value = v as ExcelJS.CellValue;
        if (v instanceof Date) cell.numFmt = 'yyyy-mm-dd';
      }
    });
    const st = wb.addWorksheet('Setting');
    st.getCell('I1').value = 'Project Staff';
    ['Name', 'Role', 'Region', 'Status'].forEach((h, i) => { st.getCell(2, 9 + i).value = h; });
    for (const s of ['RF & Design', 'Acquisition']) wb.addWorksheet(s);
    return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  }
  const uploadMaster = (api: Api, buf: Buffer): request.Test => {
    const t = api.raw('post', '/master-import/runs');
    if (api.csrf) t.set('X-CSRF-Token', api.csrf);
    return t.attach('file', buf, { filename: 'GSDN_Site_Master.xlsx', contentType: 'application/octet-stream' });
  };
  const apply = (api: Api, run: { id: string; version: number }, body: Record<string, unknown>) =>
    api.call('post', `/master-import/runs/${run.id}/apply`, { mode: 'submit', reason: 'Initial load of the Master', ...body }, { 'If-Match': `"${run.version}"` });
  // B8 "Tower MOS" needs the MOS proof (document B9); its Master column is AZ (CW MOS actual date)
  const run = async (a: Actor, rows: Record<string, Cell>[]) => {
    const res = await uploadMaster(a.api, await masterFile(rows));
    expect(res.status).toBe(201);
    return res.body as { id: string; version: number };
  };

  it('an unmarked apply refuses the row for the missing document; a marked apply accepts the row before the cutoff, flags it, and refuses the row after it', async () => {
    const t = await team();
    const unmarked = await siteWith(['B8']);
    const before = await siteWith(['B8']);
    const after = await siteWith(['B8']);
    expect((await openWaiver(t.admin)).status).toBe(200);

    const r1 = await run(t.admin, [{ A: 1, B: unmarked.site.code, AZ: day(BEFORE) }]);
    const a1 = await apply(t.admin.api, r1, {});
    expect(a1.status).toBe(200);
    expect(a1.body.outcome.batches[0]).toMatchObject({ submitted: 0, errors: 1 });
    expect((await taskFlag(unmarked.tasks.B8!)).f).toBe(false);
    expect((await taskFlag(unmarked.tasks.B8!)).state).toBe('open');

    const r2 = await run(t.admin, [{ A: 1, B: before.site.code, AZ: day(BEFORE) }, { A: 2, B: after.site.code, AZ: day(AFTER) }]);
    const a2 = await apply(t.admin.api, r2, { historical_load: { reason: REASON } });
    expect(a2.status).toBe(200);
    expect(a2.body.outcome.batches[0]).toMatchObject({ submitted: 1, errors: 1 });
    const flagged = await taskFlag(before.tasks.B8!);
    expect(['in_review', 'in_approval']).toContain(flagged.state);
    expect(flagged).toMatchObject({ f: true });
    expect(flagged.miss).toEqual(['B9']);
    expect((await taskFlag(after.tasks.B8!)).f).toBe(false);
    const batch = await q<{ historical_load: boolean; historical_cutoff: string; source: string }>(db, `SELECT historical_load, historical_cutoff::text, source FROM import_batches WHERE id = $1`, [a2.body.outcome.batches[0].id]);
    expect(batch[0]).toEqual({ historical_load: true, historical_cutoff: CUTOFF, source: 'master_import' });
    const fl = (await audit('task_historical_no_documents', before.tasks.B8))[0]!;
    expect(fl).toMatchObject({ is_admin_override: true, after: { historical_no_documents: true, missing_documents: ['B9'], cutoff_date: CUTOFF } });
    expect(fl.after!.batch_id).toBe(a2.body.outcome.batches[0].id);
    expect((await audit('master_import.apply')).at(-1)!.after).toMatchObject({ historical_load: true });
  });

  it('is for a System Admin: a delegate of templates administer is refused, a step-up and the open waiver are required, and draft mode cannot be marked', async () => {
    const t = await team();
    const s = await siteWith(['B8']);
    const dg = await makeUser(db, { assigned: true });
    await delegate(db, dg.id, [['templates', 'view'], ['templates', 'administer'], ['templates', 'import'], ['sites', 'view'], ['sites', 'edit']]);
    const dgApi = await loggedIn(app, dg);
    await dgApi.stepUp(dg.password);
    expect((await openWaiver(t.admin)).status).toBe(200);
    const file = await masterFile([{ A: 1, B: s.site.code, AZ: day(BEFORE) }]);
    const r = (await uploadMaster(t.admin.api, file)).body as { id: string; version: number };
    // the delegate may use the legacy import, but not the historical option
    const byDelegate = await apply(dgApi, r, { historical_load: { reason: REASON } });
    expect(byDelegate.status).toBe(403);
    expect(byDelegate.body).toMatchObject({ code: 'action_forbidden' });
    const cold = await plainAdmin(app, db, false);
    const noStep = await apply(cold.api, r, { historical_load: { reason: REASON } });
    expect(noStep.status).toBe(401);
    expect((await apply(t.admin.api, r, { mode: 'draft', historical_load: { reason: REASON } })).status).toBe(422);
    expect((await apply(t.admin.api, r, { historical_load: { reason: 'x' } })).status).toBe(422);
    await closeWaiver(t.admin);
    const shut = await apply(t.admin.api, r, { historical_load: { reason: REASON } });
    expect(shut.status).toBe(409);
    expect(shut.body).toMatchObject({ code: 'invalid_transition' });
    expect((await taskFlag(s.tasks.B8!)).f).toBe(false);
    expect((await q<{ status: string }>(db, 'SELECT status FROM master_reconciliation_runs WHERE id = $1', [r.id]))[0]!.status).toBe('previewed');
  });
});

describe('the flag is reversible: the documents uploaded later clear it', () => {
  it('takes the missing document after the approval, clears the flag and the badge, audits it, and changes nothing else', async () => {
    const t = await team(['B6']);
    const a = await siteWith(['B6']);
    expect((await openWaiver(t.admin)).status).toBe(200);
    const up = await upl(t.admin, [{ 'Site ID': a.site.code, 'B6 Actual Date': day(BEFORE) }], { historical_load_reason: REASON });
    const sent = await send(t.admin, up.body);
    expect(sent.status).toBe(200);
    expect((await t.approver.api.call('post', `/import-batches/${up.body.id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': `"${sent.body.version}"` })).status).toBe(200);
    const before = await taskFlag(a.tasks.B6!);
    expect(before).toMatchObject({ state: 'approved', f: true });

    // the slot is missing and takes a file although the task is approved
    const slot = await slotOf(t.admin.api, a.tasks.B6!, 'B6');
    expect(slot).toMatchObject({ status: 'missing', can_upload: true });
    // a task that was never flagged takes no file once approved (the normal rule)
    const plain = await siteWith(['B6']);
    await db.query(`UPDATE task_instances SET state = 'approved', current_level = 0 WHERE id = $1`, [plain.tasks.B6]);
    const plainSlots = await slots(t.admin.api, plain.tasks.B6!);
    expect(plainSlots.every((s) => s.can_upload === false)).toBe(true);

    const noAccess = await actor(app, db, { grants: [['sites', 'view'], ['sites', 'edit']], regions: [R], modules: null });
    expect((await upload(noAccess.api, a.tasks.B6!, slot.id, PDF, 'layout.pdf')).status).toBe(403);          // only an L1 holder (or a System Admin without one)
    const up2 = await upload(t.admin.api, a.tasks.B6!, slot.id, PDF, 'layout.pdf');
    expect(up2.status).toBe(201);

    const after = await taskFlag(a.tasks.B6!);
    expect(after).toMatchObject({ state: 'approved', f: false, batch: up.body.id });
    expect(after.cleared).not.toBeNull();
    expect(after.version).toBe(before.version + 1);
    expect((await t.admin.api.call('get', `/tasks/${a.tasks.B6}`)).body).toMatchObject({ historical_no_documents: false, historical_load: null, state: 'approved' });
    expect((await slotOf(t.admin.api, a.tasks.B6!, 'B6')).status).toBe('uploaded');
    const cl = (await audit('task_historical_no_documents_cleared', a.tasks.B6))[0]!;
    expect(cl).toMatchObject({ actor_id: t.admin.user.id, before: { historical_no_documents: true, missing_documents: ['B6'] }, after: { historical_no_documents: false }, is_admin_override: false });
    // a second upload (a replacement of the slot) is not a second clearing
    expect(await audit('task_historical_no_documents_cleared', a.tasks.B6)).toHaveLength(1);
  });

  it('loses the flag when the task goes back to Data Entry (a rejection), so the normal rule applies to its next submit', async () => {
    const t = await team(['B6']);
    const a = await siteWith(['B6']);
    expect((await openWaiver(t.admin)).status).toBe(200);
    const up = await upl(t.admin, [{ 'Site ID': a.site.code, 'B6 Actual Date': day(BEFORE) }], { historical_load_reason: REASON });
    const sent = await send(t.admin, up.body);
    expect((await taskFlag(a.tasks.B6!)).f).toBe(true);
    const rej = await t.approver.api.call('post', `/import-batches/${up.body.id}/decisions`, { action: 'reject', scope: 'all', note: 'Send the layout' }, { 'If-Match': `"${sent.body.version}"` });
    expect(rej.status).toBe(200);
    const back = await taskFlag(a.tasks.B6!);
    expect(back).toMatchObject({ state: 'entry', f: false });
    const au = (await audit('task_historical_no_documents_cleared', a.tasks.B6))[0]!;
    expect(au).toMatchObject({ before: { historical_no_documents: true }, after: { historical_no_documents: false } });
    // the L1 holder cannot submit it again without the document
    const again = await t.admin.api.call('post', `/tasks/${a.tasks.B6}/submit`, {}, { 'If-Match': `"${(await taskFlag(a.tasks.B6!)).version}"` });
    expect(again.status).toBe(422);
    expect(again.body).toMatchObject({ code: 'mandatory_slots_missing' });
  });
});

describe('KPIs: a flagged task is treated like an admin override', () => {
  it('is left out of the SLA and on-time figures when exclude_overrides is on, counted when it is off, flagged in the meta either way, and left out of the health index documentation factor', async () => {
    const KR = 6;                                              // a region of its own: the figures below are counted for it
    const t = await team(['B6'], KR);
    const a = await siteWith(['B6'], KR);
    const control = await siteWith(['B6'], KR);
    expect((await openWaiver(t.admin)).status).toBe(200);
    const up = await upl(t.admin, [{ 'Site ID': a.site.code, 'B6 Actual Date': day(BEFORE) }], { historical_load_reason: REASON });
    const sent = await send(t.admin, up.body);
    await t.approver.api.call('post', `/import-batches/${up.body.id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': `"${sent.body.version}"` });
    expect((await taskFlag(a.tasks.B6!))).toMatchObject({ state: 'approved', f: true });

    // two closed, on-time SLA clocks: the flagged task and a control task that was never flagged (written as the superuser with the triggers off)
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    for (const id of [a.tasks.B6!, control.tasks.B6!]) {
      await db.query(
        `UPDATE task_instances SET state = 'approved', current_level = 0, actual_date = $2::date, approved_date = $2::date, sla_rule_id = (SELECT id FROM sla_rules WHERE max_working_days IS NOT NULL ORDER BY id LIMIT 1),
           sla_start_date = $2::date - 3, sla_end_date = $2::date, sla_elapsed_wd = 1, due_date = $2::date + 10 WHERE id = $1`, [id, BEFORE]);
    }
    // the control task's mandatory document is approved; the flagged task's is missing
    await db.query(`UPDATE document_slots SET status = 'approved' WHERE task_id = $1`, [control.tasks.B6]);
    await db.query('COMMIT');
    expect((await taskFlag(a.tasks.B6!)).f).toBe(true);

    const flaggedNow = 1;                                       // the flagged task of this region
    const kpi = async (exclude: boolean) => (await t.admin.api.call('get', `/dashboard?exclude_overrides=${exclude}&region_id=${KR}`)).body;
    const on = await kpi(true);
    const off = await kpi(false);
    expect(on.meta).toMatchObject({ overrides_excluded: true, override_flagged_count: flaggedNow, historical_flagged_count: flaggedNow });
    expect(off.meta).toMatchObject({ overrides_excluded: false, override_flagged_count: flaggedNow, historical_flagged_count: flaggedNow });
    expect(off.sla.totals.completed_on_time - on.sla.totals.completed_on_time).toBe(1);        // the flagged task: counted when off, left out when on
    expect(on.sla.totals.completed_on_time).toBeGreaterThanOrEqual(1);                         // the control task stays in
    // the health index: documentation completeness (D) leaves the flagged tasks out whatever the switch says (their documents are missing by design), like an override
    const factor = (b: any, code: string) => b.health.components.find((c: { code: string }) => c.code === code);
    expect(factor(on, 'D').value).toBe(100);                  // 1 of 1 documents approved (the control task); counting the flagged task's missing one would give 50
    expect(factor(off, 'D').value).toBe(100);
  });
});

describe('the direct database paths refuse the flag and the mark unless the waiver allows them', () => {
  /** Runs `fn` in a transaction with the verified context of `userId` (or none), rolls it back, and returns the error message (null when nothing was refused). */
  async function attempt(userId: string | null, o: { stepup?: boolean }, fn: () => Promise<unknown>): Promise<string | null> {
    await db.query('BEGIN');
    try {
      if (userId) await beginAs(db, userId, o.stepup ? { stepupUntil: new Date(Date.now() + 300_000) } : {});
      await fn();
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      await db.query('ROLLBACK');
    }
  }
  const flag = (task: string, batch: string | null, actual: string | null = BEFORE) =>
    () => db.query(`UPDATE task_instances SET historical_no_documents = true, historical_batch_id = $2, historical_flagged_at = now(), actual_date = $3::date WHERE id = $1`, [task, batch, actual]);
  const mark = (batch: string, by: string, cutoff: string = CUTOFF, reason = REASON) =>
    () => db.query(`UPDATE import_batches SET historical_load = true, historical_cutoff = $2::date, historical_reason = $3, historical_marked_by = $4, historical_marked_at = now() WHERE id = $1`, [batch, cutoff, reason, by]);

  it('refuses to flag a task without a batch, with an unmarked batch, or without a signed-in actor', async () => {
    const t = await team(['B6']);
    const s = await siteWith(['B6']);
    expect((await openWaiver(t.admin)).status).toBe(200);
    const plain = await upl(t.admin, [{ 'Site ID': s.site.code, 'B6 Actual Date': day(BEFORE) }]);          // not marked
    const task = s.tasks.B6!;
    expect(await attempt(null, {}, flag(task, null))).toMatch(/historical waiver: a task is flagged only|task_instances_historical_check/);
    expect(await attempt(null, {}, flag(task, plain.body.id))).toMatch(/historical waiver: a task is flagged only through a batch marked/);
    expect(await attempt(t.admin.user.id, { stepup: true }, flag(task, plain.body.id))).toMatch(/historical waiver: a task is flagged only through a batch marked/);
  });

  it('flags a task only for the System Admin who marked the batch, under the open waiver, for a row of that batch with an actual date on or before the cutoff', async () => {
    const t = await team(['B6']);
    const a = await siteWith(['B6']);
    const b = await siteWith(['B6']);
    const outside = await siteWith(['B6']);
    expect((await openWaiver(t.admin)).status).toBe(200);
    const up = await upl(t.admin, [{ 'Site ID': a.site.code, 'B6 Actual Date': day(BEFORE) }, { 'Site ID': b.site.code, 'B6 Actual Date': day(AFTER) }], { historical_load_reason: REASON });
    expect(up.status).toBe(202);
    const batch = up.body.id as string;
    const refused = /historical waiver: a task is flagged only through a batch marked/;
    // the control: the right actor, the row of the batch, the date before the cutoff
    expect(await attempt(t.admin.user.id, { stepup: true }, flag(a.tasks.B6!, batch))).toBeNull();
    // the row after the cutoff, a task that is not in the batch, a date missing
    expect(await attempt(t.admin.user.id, { stepup: true }, flag(b.tasks.B6!, batch, AFTER))).toMatch(refused);
    expect(await attempt(t.admin.user.id, { stepup: true }, flag(outside.tasks.B6!, batch))).toMatch(refused);
    expect(await attempt(t.admin.user.id, { stepup: true }, flag(a.tasks.B6!, batch, null))).toMatch(refused);
    // another System Admin, an ordinary user, nobody
    const other = await plainAdmin(app, db);
    expect(await attempt(other.user.id, { stepup: true }, flag(a.tasks.B6!, batch))).toMatch(refused);
    expect(await attempt(t.approver.user.id, { stepup: true }, flag(a.tasks.B6!, batch))).toMatch(refused);
    expect(await attempt(null, {}, flag(a.tasks.B6!, batch))).toMatch(refused);
    // the waiver is closed
    expect((await closeWaiver(t.admin)).status).toBe(200);
    expect(await attempt(t.admin.user.id, { stepup: true }, flag(a.tasks.B6!, batch))).toMatch(refused);
    expect((await taskFlag(a.tasks.B6!)).f).toBe(false);
  });

  it('marks a batch only for a System Admin with a step-up under the open waiver and its cutoff date, and the mark never changes', async () => {
    const t = await team(['B6']);
    const a = await siteWith(['B6']);
    const other = await siteWith(['B6']);
    const plain = await upl(t.admin, [{ 'Site ID': a.site.code, 'B6 Actual Date': day(BEFORE) }]);
    const batch = plain.body.id as string;
    const refused = /historical waiver: a batch is marked only by a System Admin/;
    // the waiver is closed
    expect(await attempt(t.admin.user.id, { stepup: true }, mark(batch, t.admin.user.id))).toMatch(refused);
    expect((await openWaiver(t.admin)).status).toBe(200);
    expect(await attempt(t.admin.user.id, { stepup: true }, mark(batch, t.admin.user.id))).toBeNull();           // the control
    expect(await attempt(t.admin.user.id, {}, mark(batch, t.admin.user.id))).toMatch(refused);                    // no step-up
    expect(await attempt(t.admin.user.id, { stepup: true }, mark(batch, t.admin.user.id, '2026-02-15'))).toMatch(refused);   // not the cutoff of the waiver
    expect(await attempt(t.approver.user.id, { stepup: true }, mark(batch, t.approver.user.id))).toMatch(refused);          // not a System Admin
    expect(await attempt(t.admin.user.id, { stepup: true }, mark(batch, t.approver.user.id))).toMatch(refused);             // marked in someone else's name
    expect(await attempt(null, {}, mark(batch, t.admin.user.id))).toMatch(refused);
    expect(await attempt(t.admin.user.id, { stepup: true }, mark(batch, t.admin.user.id, CUTOFF, 'x'))).toMatch(/historical_check|check constraint/);   // reason too short
    // cutoff data without the mark
    expect(await attempt(t.admin.user.id, { stepup: true }, () => db.query(`UPDATE import_batches SET historical_cutoff = $2::date WHERE id = $1`, [batch, CUTOFF]))).toMatch(/no mark data without the mark/);
    // a marked batch keeps its mark: no change of the date, the reason, the marker; no un-marking
    const up = await upl(t.admin, [{ 'Site ID': other.site.code, 'B6 Actual Date': day(BEFORE) }], { historical_load_reason: REASON });
    const marked = up.body.id as string;
    const never = /the mark of a batch never changes/;
    expect(await attempt(t.admin.user.id, { stepup: true }, () => db.query(`UPDATE import_batches SET historical_cutoff = '2026-01-15' WHERE id = $1`, [marked]))).toMatch(never);
    expect(await attempt(t.admin.user.id, { stepup: true }, () => db.query(`UPDATE import_batches SET historical_reason = 'Another reason' WHERE id = $1`, [marked]))).toMatch(never);
    expect(await attempt(t.admin.user.id, { stepup: true }, () => db.query(`UPDATE import_batches SET historical_load = false WHERE id = $1`, [marked]))).toMatch(never);
    expect(await attempt(null, {}, () => db.query(`UPDATE import_batches SET historical_load = false, historical_marked_by = NULL WHERE id = $1`, [marked]))).toMatch(never);
    // an ordinary update of the batch is not blocked
    expect(await attempt(null, {}, () => db.query(`UPDATE import_batches SET note = 'checked' WHERE id = $1`, [marked]))).toBeNull();
    // a register batch is never marked
    const reg = (await q<{ id: string }>(db, `SELECT id FROM import_batches WHERE stream_code IS NULL LIMIT 1`))[0];
    if (reg) expect(await attempt(t.admin.user.id, { stepup: true }, mark(reg.id, t.admin.user.id))).toMatch(refused);
  });

  it('refuses to write the setting from the application role, as a System Admin session with a step-up: the migration role is the only other writer', async () => {
    const t = await team(['B6']);
    for (const sql of [
      `UPDATE settings SET value = '{"open": true, "cutoff_date": "2026-01-31", "expires_at": "2999-01-01T00:00:00Z"}'::jsonb WHERE key = 'load.historical_waiver'`,
      `DELETE FROM settings WHERE key = 'load.historical_waiver'`,
    ]) {
      await db.query('BEGIN');
      try {
        await db.query('SET LOCAL ROLE pmis_app');
        await beginAs(db, t.admin.user.id, { stepupUntil: new Date(Date.now() + 300_000) });
        await expect(db.query(sql)).rejects.toThrow(/written only by hw_waiver_set/);
      } finally {
        await db.query('ROLLBACK');
      }
    }
    expect((await t.admin.api.call('get', '/settings/historical-waiver')).body).toMatchObject({ open: false });
  });
});
