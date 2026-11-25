import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import type { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, startApp, superDbHgd } from './helpers';
import { day } from './tpl-helpers';
import { SITE_ENTRY_GRANTS } from './tpl-stream-helpers';
import { Actor, Site, actor, makeSite, makeTask, plainAdmin } from './wf-helpers';

/**
 * Migration 0127 (owner decisions 2026-11-19): on a site of a historical Master load approved directly, a phase gate the site moved past (a task the gate holds,
 * or a later one, approved with an actual date) is open by an admin override, and a milestone with no date of its own (every predecessor approved or N/A, none
 * dated) takes the date of the earliest later task approved with an actual date ("inferred date - historical load", admin override). Both run with the 0126
 * no-source rule until nothing changes, in the catch-up of the migration and at the end of every historical load approved directly; both are taken back by the
 * existing revert door and never applied again; a live site is never touched. Its own database (TEST_DATABASE_URL_HGD): the catch-up reads every site of a
 * historical load. Synthetic data only. Region 3.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 3;
const REASON = 'Historical Master of the owner, with direct approval';

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_HGD as string });
  db = await superDbHgd();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

/** A synthetic legacy Master: the Master sheet only (three header rows, data from row 5). */
async function masterFile(rows: Record<string, string | number | Date | null>[]): Promise<Buffer> {
  const cols = await q<{ letter: string; group_top: string | null; group_mid: string | null; name: string | null }>(db, 'SELECT letter, group_top, group_mid, name FROM master_columns WHERE is_active ORDER BY ord');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Guide').getCell('A1').value = 'Guide';
  const ws = wb.addWorksheet('Master');
  for (const c of cols) {
    ws.getCell(`${c.letter}1`).value = c.group_top ?? null;
    ws.getCell(`${c.letter}2`).value = c.group_mid ?? null;
    ws.getCell(`${c.letter}3`).value = c.name ?? null;
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
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
const uploadMaster = (api: Api, buf: Buffer): request.Test => {
  const r = api.raw('post', '/master-import/runs');
  if (api.csrf) r.set('X-CSRF-Token', api.csrf);
  return r.attach('file', buf, { filename: 'GSDN_Site_Master.xlsx', contentType: 'application/octet-stream' });
};
/** Uploads the file and applies it with the direct approval; returns the run id. */
async function load(admin: Actor, file: Buffer, reapply = false): Promise<string> {
  const w = await admin.api.call('put', '/settings/historical-waiver', { open: true, cutoff_date: '2026-06-30', reason: 'Open for the historical load' });
  expect([200, 409]).toContain(w.status);
  const run = await uploadMaster(admin.api, file);
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  const applied = await admin.api.call('post', `/master-import/runs/${run.body.id}/apply`,
    { mode: 'submit', reason: 'Load', historical_load: { reason: REASON, approve_directly: true, ...(reapply ? { reapply: true } : {}) } },
    { 'If-Match': `"${run.body.version}"` });
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  return run.body.id as string;
}

interface TaskRow { id: string; code: string; state: string; hid: boolean; override: boolean; actual_date: string | null; lock_reason: string | null }
const tasks = async (siteId: string): Promise<Record<string, TaskRow>> => Object.fromEntries((await q<TaskRow>(db,
  `SELECT t.id::text AS id, td.code, t.state::text AS state, t.historical_inferred_date AS hid, t.admin_override AS override, t.actual_date::text AS actual_date, t.lock_reason
   FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id WHERE t.site_id = $1`, [siteId])).map((r) => [r.code, r]));
const audits = async (action: string, siteId: string) => (await q<{ n: number }>(db,
  'SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND site_id = $2', [action, siteId]))[0]!.n;
const stage = async (siteId: string) => (await q<{ s: string }>(db, 'SELECT hns_current_stage($1) AS s', [siteId]))[0]!.s;
const gate = async (siteId: string, g: string) => (await q<{ status: string; gate_date: string | null }>(db,
  'SELECT status, gate_date::text AS gate_date FROM gate_eval($1, $2)', [siteId, g]))[0]!;
const overrides = async (siteId: string, kind: string) => q<{ id: string; entity: string; task_id: string | null; after: Record<string, any>; reverted: boolean; acted_by: string }>(db,
  `SELECT id::text AS id, entity, task_id::text AS task_id, after, reverted_at IS NOT NULL AS reverted, acted_by::text AS acted_by FROM admin_overrides
   WHERE site_id = $1 AND kind = $2 ORDER BY created_at`, [siteId, kind]);
const catchUp = async () => (await q<{ r: Record<string, any> }>(db, 'SELECT hgd_catch_up() AS r'))[0]!.r;

/** Puts a site in the scope of the rule as an earlier historical load left it (fixture rows, triggers off): the task carries a historical direct-approval batch. */
async function markHistorical(admin: Actor, siteId: string, code: string): Promise<void> {
  const tv = (await q<{ id: string }>(db, `SELECT v.id::text AS id FROM template_versions v JOIN template_definitions dd ON dd.id = v.template_def_id WHERE dd.template_id = 'TPL-ACQUISITION' AND v.is_current`))[0]!.id;
  await db.query('SET session_replication_role = replica');
  try {
    const b = (await q<{ id: string }>(db, `INSERT INTO import_batches (template_version_id, source, file_name, file_sha256, status, uploaded_by, register_key, mode,
        historical_load, historical_cutoff, historical_reason, historical_marked_by, historical_marked_at, historical_direct_approve, closed_at)
      VALUES ($1, 'master_import', 'GSDN_Site_Master.xlsx', repeat('f', 64), 'approved', $2, 'acquisition', 'submit', true, '2026-06-30', $3, $2, now(), true, now()) RETURNING id::text AS id`,
      [tv, admin.user.id, REASON]))[0]!.id;
    await db.query(`UPDATE task_instances t SET historical_direct_approved = true, historical_direct_batch_id = $3, historical_direct_approved_at = now()
      FROM task_definitions td WHERE td.id = t.task_def_id AND td.code = $2 AND t.site_id = $1`, [siteId, code, b]);
  } finally {
    await db.query('SET session_replication_role = origin');
  }
}
type Spec = [code: string, state: string, date?: string];
async function build(prefix: string, spec: Spec[]): Promise<Site> {
  const s = await makeSite(db, R, { prefix, status: 'in_progress' });
  for (const [code, state, date] of spec) await makeTask(db, s, code, state, { actualDate: date ?? null });
  return s;
}
/** Design & Acquisition and PRE-CW approved with dates, PRE-CW Completion waiting for its calculation, CW (MS3) waiting for the gate G3. */
const throughPreCw: Spec[] = [
  ['A1', 'approved', '2026-01-02'], ['A2', 'approved', '2026-01-04'], ['A3', 'approved', '2026-01-05'], ['A4', 'approved', '2026-01-06'], ['A5', 'na'],
  ['MS1', 'approved', '2026-01-06'],
  ['B1', 'approved', '2026-01-10'], ['B2', 'approved', '2026-01-11'], ['B3', 'approved', '2026-01-12'], ['B4', 'approved', '2026-01-13'],
  ['B5', 'approved', '2026-01-14'], ['B6', 'approved', '2026-01-15'], ['B7', 'approved', '2026-01-16'], ['MS2', 'open'],
];

describe('0127: gates the site moved past are open, milestones with no date take the earliest later date (historical load)', () => {
  let admin: Actor;
  let cw: Site; let noDate: Site; let stuck: Site; let idle: Site; let live: Site;
  let runId: string;

  it('(a) the historical load: G3 holds CW for want of permits, the TE work is approved later: G3 opens by an admin override, CW Completion is calculated by its own rule, Site RFI is pre-filled', async () => {
    admin = await plainAdmin(app, db);
    cw = await build('HGA', [...throughPreCw,
      ['B8', 'approved', '2026-02-01'], ['B9', 'approved', '2026-02-02'], ['B10', 'approved', '2026-02-05'], ['B11', 'approved', '2026-02-06'], ['MS3', 'locked'],
      ['B13', 'locked'], ['C1', 'na'], ['C2', 'na'], ['C3', 'na'], ['C4', 'na'], ['MS4', 'locked'],
      ['D1', 'locked'], ['D2', 'locked'], ['D3', 'locked'], ['D4', 'locked'], ['D4b', 'locked'], ['D5', 'locked'], ['D6', 'locked'], ['MS5', 'locked']]);
    await db.query(`UPDATE task_instances t SET lock_reason = 'gate_closed:G3' FROM task_definitions td WHERE td.id = t.task_def_id AND td.code = 'MS3' AND t.site_id = $1`, [cw.id]);
    // the owner's file: CW PAC (B13, BV) and the TE work (D2 CC, D5 CJ, D6 CS) with dates; no permit anywhere
    runId = await load(admin, await masterFile([{ A: 1, B: cw.code, BV: day('2026-03-01'), CC: day('2026-03-10'), CJ: day('2026-03-20'), CS: day('2026-03-25') }]));

    const t = await tasks(cw.id);
    expect(t.D6).toMatchObject({ state: 'approved', actual_date: '2026-03-25' });
    expect(t.MS2).toMatchObject({ state: 'approved', actual_date: '2026-01-16' });
    expect(await gate(cw.id, 'G3')).toMatchObject({ status: 'open', gate_date: '2026-01-16' });
    // CW Completion by its own rule (E3: the latest of B10 and B11, the gate date at least): not inferred, not an override
    expect(t.MS3).toMatchObject({ state: 'approved', actual_date: '2026-02-06', hid: false, override: false });
    // Site RFI: pre-filled with the latest condition date (Q38); since 0129 the site moved past it, so it is approved directly with that date (admin override)
    expect(t.MS4!.state).toBe('approved');
    expect(t.MS4!.actual_date).toBe('2026-03-01');
    expect(await stage(cw.id)).toBe('done');

    const ov = (await overrides(cw.id, 'historical_gate_open')).filter((o) => o.after.gate === 'G3');   // and G5 since 0129 (below)
    expect(ov).toHaveLength(1);
    expect(ov[0]).toMatchObject({ entity: 'site', task_id: null, reverted: false, acted_by: admin.user.id,
      after: { gate: 'G3', status: 'open', evidence_task: 'B8', evidence_date: '2026-02-01' } });
    const st = await q<{ o: string | null }>(db, `SELECT historical_open_override::text AS o FROM site_gate_state WHERE site_id = $1 AND gate_code = 'G3'`, [cw.id]);
    expect(st[0]!.o).toBe(ov[0]!.id);
    const au = await q<{ after: Record<string, any>; is_admin_override: boolean; reason: string }>(db,
      `SELECT after, is_admin_override, reason FROM audit_log WHERE action = 'site_historical_gate_open' AND site_id = $1 AND after ->> 'gate' = 'G3'`, [cw.id]);
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({ is_admin_override: true, reason: REASON, after: { gate: 'G3', override_id: ov[0]!.id, evidence_task: 'B8', catch_up: false } });
    const step = await q<{ action: string; note: string }>(db,
      `SELECT action::text AS action, note FROM workflow_steps WHERE task_id = $1 AND action = 'admin_override'`, [t.MS3!.id]);
    expect(step).toHaveLength(1);
    expect(step[0]!.note).toContain('gate G3 is open');
    // the summary of the run
    const sum = await q<{ after: Record<string, any>; is_admin_override: boolean }>(db,
      `SELECT after, is_admin_override FROM audit_log WHERE action = 'historical_gates_dates_apply' AND entity_id = $1`, [runId]);
    expect(sum).toHaveLength(1);
    expect(sum[0]).toMatchObject({ is_admin_override: true, after: { sites_in_scope: 1, gates_opened: 2, gates_opened_by_gate: { G3: 1, G5: 1 }, milestones_inferred: 0,
      manual_ms_approved: 1, current_stage_after: { done: 1 }, waiting_after: {} } });   // 0129: Site RFI approved directly, then G5 and TE Completion
    // the site page lists the gate override among the admin edits of the site, revertible
    const sd = await admin.api.call('get', `/sites/${cw.id}`);
    expect(sd.status, JSON.stringify(sd.body)).toBe(200);
    expect(sd.body.admin_edits.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: ov[0]!.id, kind: 'historical_gate_open', revertible: true })]));
  });

  it('(a) later gates follow: once Site RFI is approved (directly since 0129, in the same run), G5 (TE permits) opens on the evidence of the TE work and TE Completion is calculated', async () => {
    expect(await gate(cw.id, 'G5')).toMatchObject({ status: 'open', gate_date: '2026-03-01' });
    const t = await tasks(cw.id);
    expect(t.MS5).toMatchObject({ state: 'approved', actual_date: '2026-03-25', hid: false });
    const ov = (await overrides(cw.id, 'historical_gate_open')).find((o) => o.after.gate === 'G5')!;
    expect(ov.after).toMatchObject({ evidence_task: 'D2', evidence_date: '2026-03-10' });
    const au = await q<{ actor_id: string | null; after: Record<string, any> }>(db,
      `SELECT actor_id::text AS actor_id, after FROM audit_log WHERE action = 'site_historical_gate_open' AND site_id = $1 AND after ->> 'gate' = 'G5'`, [cw.id]);
    expect(au[0]).toMatchObject({ actor_id: admin.user.id, after: { catch_up: false } });   // the System Admin of the load
  });

  it('(b) Site Release with every predecessor N/A and no date, PRE-CW approved with dates: MS1 takes the date of the earliest later task (B1), flagged inferred; PRE-CW Completion follows', async () => {
    noDate = await build('HGB', [['A1', 'na'], ['A2', 'na'], ['A3', 'na'], ['A4', 'na'], ['A5', 'na'], ['MS1', 'open'],
      ['B1', 'approved', '2026-02-01'], ['B2', 'approved', '2026-02-10'], ['B3', 'na'], ['B4', 'na'], ['B5', 'na'], ['B6', 'na'], ['B7', 'na'], ['MS2', 'locked']]);
    // PRE-CW Completion waits for the gate G2, which waits for a date of Site Release (as the engine left it)
    await db.query(`UPDATE task_instances t SET lock_reason = 'gate_closed:G2' FROM task_definitions td WHERE td.id = t.task_def_id AND td.code = 'MS2' AND t.site_id = $1`, [noDate.id]);
    await markHistorical(admin, noDate.id, 'B1');
    const out = await catchUp();
    expect(out.milestones_inferred_by_code).toMatchObject({ MS1: 1 });
    const t = await tasks(noDate.id);
    expect(t.MS1).toMatchObject({ state: 'approved', actual_date: '2026-02-01', hid: true, override: true });
    // PRE-CW Completion by its own rule: the gate G2 (the date of MS1) and the latest of its dated tasks
    expect(t.MS2).toMatchObject({ state: 'approved', actual_date: '2026-02-10', hid: false });
    const ov = await overrides(noDate.id, 'historical_inferred_date');
    expect(ov).toHaveLength(1);
    expect(ov[0]).toMatchObject({ entity: 'task', task_id: t.MS1!.id, reverted: false,
      after: { state: 'approved', actual_date: '2026-02-01', note: 'inferred date — historical load', evidence_task: 'B1', evidence_date: '2026-02-01' } });
    const au = await q<{ after: Record<string, any>; is_admin_override: boolean; actor_id: string }>(db,
      `SELECT after, is_admin_override, actor_id::text AS actor_id FROM audit_log WHERE action = 'task_historical_inferred_date' AND entity_id = $1`, [t.MS1!.id]);
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({ is_admin_override: true, actor_id: admin.user.id,
      after: { historical_inferred_date: true, reason_code: 'historical_inferred_date', task_code: 'MS1', evidence_task: 'B1', evidence_date: '2026-02-01', catch_up: true } });
    const st = await q<{ action: string; note: string }>(db, `SELECT action::text AS action, note FROM workflow_steps WHERE task_id = $1 AND action = 'admin_override'`, [t.MS1!.id]);
    expect(st[0]!.note).toContain('inferred date — historical load');
    // the task screen lists the override as revertible
    const detail = await admin.api.call('get', `/tasks/${t.MS1!.id}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.overrides).toEqual(expect.arrayContaining([expect.objectContaining({ id: ov[0]!.id, kind: 'historical_inferred_date', revertible: true })]));
  });

  it('(c) a site with no later work: the gate stays closed and the milestone without a date stays open; (d) a live site is untouched', async () => {
    stuck = await build('HGC', [...throughPreCw, ['B8', 'locked'], ['B9', 'locked'], ['B10', 'locked'], ['B11', 'locked'], ['MS3', 'locked']]);
    await markHistorical(admin, stuck.id, 'B1');
    idle = await build('HGI', [['A1', 'approved', '2026-01-02'], ['A2', 'na'], ['A3', 'na'], ['A4', 'na'], ['A5', 'na'], ['MS1', 'open'], ['B1', 'locked']]);
    await markHistorical(admin, idle.id, 'A1');
    live = await build('HGL', [['A1', 'na'], ['A2', 'na'], ['A3', 'na'], ['A4', 'na'], ['A5', 'na'], ['MS1', 'open'], ['B1', 'approved', '2026-02-01'],
      ['B2', 'approved', '2026-02-02'], ['B3', 'na'], ['B4', 'na'], ['B5', 'na'], ['B6', 'na'], ['B7', 'na'], ['MS2', 'locked'],
      ['B8', 'approved', '2026-03-01'], ['B9', 'locked'], ['B10', 'locked'], ['B11', 'locked'], ['MS3', 'locked']]);
    await db.query('SELECT calc_refresh_site($1)', [stuck.id]);
    const out = await catchUp();
    expect((await tasks(stuck.id)).MS2!.state).toBe('approved');
    expect((await gate(stuck.id, 'G3')).status).toBe('blocked');
    expect(await overrides(stuck.id, 'historical_gate_open')).toHaveLength(0);
    expect(await stage(stuck.id)).toBe('MS3');
    const i = await tasks(idle.id);
    expect(i.MS1).toMatchObject({ state: 'open', actual_date: null, hid: false });
    expect(await overrides(idle.id, 'historical_inferred_date')).toHaveLength(0);
    expect(out.milestones_without_date).toMatchObject({ MS1: 1 });
    expect(out.waiting_after.MS3).toBeTruthy();
    // a live site: never in scope, nothing marked, opened or inferred
    const l = await tasks(live.id);
    expect(l.MS1).toMatchObject({ state: 'open', actual_date: null, hid: false, override: false });
    expect(await overrides(live.id, 'historical_inferred_date')).toHaveLength(0);
    expect(await overrides(live.id, 'historical_gate_open')).toHaveLength(0);
    expect(await audits('task_historical_inferred_date', live.id)).toBe(0);
  });

  it('(e) idempotent: the catch-up again and the same file again change nothing', async () => {
    const before = (await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM admin_overrides WHERE kind IN ('historical_gate_open', 'historical_inferred_date')`))[0]!.n;
    const again = await catchUp();
    expect(again).toMatchObject({ gates_opened: 0, milestones_inferred: 0, inferred_taken_back: 0, tasks_na: 0 });
    await load(admin, await masterFile([{ A: 1, B: cw.code, BV: day('2026-03-01'), CC: day('2026-03-10'), CJ: day('2026-03-20'), CS: day('2026-03-25') }]), true);
    const after = (await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM admin_overrides WHERE kind IN ('historical_gate_open', 'historical_inferred_date')`))[0]!.n;
    expect(after).toBe(before);
    expect((await tasks(noDate.id)).MS1).toMatchObject({ state: 'approved', actual_date: '2026-02-01', hid: true });
  });

  it('(f) revert of each kind through POST /overrides/{id}/revert: System Admin with a reason and a step-up; never applied again', async () => {
    const g3 = (await overrides(cw.id, 'historical_gate_open')).find((o) => o.after.gate === 'G3')!;
    const ms1 = (await overrides(noDate.id, 'historical_inferred_date'))[0]!;
    const clerk = await actor(app, db, { level: 'entry', grants: SITE_ENTRY_GRANTS, regions: [R], modules: null });
    for (const id of [g3.id, ms1.id]) {
      const denied = await clerk.api.call('post', `/overrides/${id}/revert`, { reason: 'Not an admin' });
      expect([403, 404]).toContain(denied.status);
    }
    const noStep = await plainAdmin(app, db, false);
    expect((await noStep.api.call('post', `/overrides/${g3.id}/revert`, { reason: 'No step-up' })).status).toBe(401);

    // the gate: closed again by its conditions; the tasks it released stay open, CW Completion is never taken back (Q81, as 0126)
    const rg = await admin.api.call('post', `/overrides/${g3.id}/revert`, { reason: 'The permits will be entered by the team' });
    expect(rg.status, JSON.stringify(rg.body)).toBe(200);
    expect(rg.body).toMatchObject({ kind: 'historical_gate_open', revertible: false });
    expect(rg.body.reverted_at).toBeTruthy();
    expect((await gate(cw.id, 'G3')).status).toBe('blocked');
    expect((await tasks(cw.id)).MS3!.state).toBe('approved');
    expect(await audits('site_historical_gate_restore', cw.id)).toBe(1);
    expect((await admin.api.call('post', `/overrides/${g3.id}/revert`, { reason: 'Again' })).status).toBe(409);

    // the milestone: open again without a date
    const rm = await admin.api.call('post', `/overrides/${ms1.id}/revert`, { reason: 'The team has the real Site Release date' });
    expect(rm.status, JSON.stringify(rm.body)).toBe(200);
    expect(rm.body).toMatchObject({ kind: 'historical_inferred_date', revertible: false });
    const t = await tasks(noDate.id);
    expect(t.MS1).toMatchObject({ state: 'open', actual_date: null, hid: false, override: false });
    expect(t.MS2!.state).toBe('approved');
    expect(await audits('task_historical_inferred_date_restore', noDate.id)).toBe(1);
    const st = await q<{ action: string }>(db, `SELECT action::text AS action FROM workflow_steps WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`, [t.MS1!.id]);
    expect(st[0]!.action).toBe('override_revert');

    // never applied again: the catch-up and a re-apply leave both as the admin left them
    const out = await catchUp();
    expect(out).toMatchObject({ gates_opened: 0, milestones_inferred: 0 });
    await load(admin, await masterFile([{ A: 1, B: cw.code, BV: day('2026-03-01'), CC: day('2026-03-10'), CJ: day('2026-03-20'), CS: day('2026-03-25') }]), true);
    expect((await gate(cw.id, 'G3')).status).toBe('blocked');
    expect((await tasks(noDate.id)).MS1).toMatchObject({ state: 'open', hid: false });
  });

  it('an inferred date gives way when the milestone has a date of its own (a re-apply dated a predecessor): taken back, then calculated by its rule', async () => {
    const s = await build('HGR', [['A1', 'na'], ['A2', 'na'], ['A3', 'na'], ['A4', 'na'], ['A5', 'na'], ['MS1', 'open'], ['B1', 'approved', '2026-02-01']]);
    await markHistorical(admin, s.id, 'B1');
    await catchUp();
    expect((await tasks(s.id)).MS1).toMatchObject({ state: 'approved', actual_date: '2026-02-01', hid: true });
    // the file now dates A2 (as a re-apply approves it directly)
    await db.query(`UPDATE task_instances t SET state = 'approved', is_na = false, actual_date = '2026-01-20' FROM task_definitions td
      WHERE td.id = t.task_def_id AND td.code = 'A2' AND t.site_id = $1`, [s.id]);
    const out = await catchUp();
    expect(out.inferred_taken_back).toBe(1);
    expect((await tasks(s.id)).MS1).toMatchObject({ state: 'approved', actual_date: '2026-01-20', hid: false, override: false });
    expect(await audits('task_historical_inferred_date_restore', s.id)).toBe(1);
  });

  it('(g) the application role cannot reach the internal functions or write the flags; a forged marker is refused', async () => {
    const app2 = new (await import('pg')).Client({ connectionString: process.env.TEST_DATABASE_URL_HGD });
    await app2.connect();
    try {
      for (const sql of [`SELECT hgd_catch_up()`, `SELECT hgd_apply_sites(ARRAY[gen_random_uuid()], 'x', false, NULL)`,
        `SELECT hgd_settle_site(gen_random_uuid(), gen_random_uuid(), 'x', false)`, `SELECT hgd_restore_gate(gen_random_uuid(), gen_random_uuid(), 'x', 'x', true)`,
        `SELECT hgd_restore_milestone(gen_random_uuid(), gen_random_uuid(), 'x', 'x', true)`, `SELECT * FROM hgd_evidence(gen_random_uuid(), gen_random_uuid(), ARRAY[]::uuid[])`,
        `SELECT hgd_waiting(gen_random_uuid())`]) {
        await expect(app2.query(sql)).rejects.toThrow(/permission denied/);
      }
      await expect(app2.query(`SELECT set_config('pmis.hgd_task', id::text, false) FROM task_instances LIMIT 1`)).resolves.toBeTruthy();
      await expect(app2.query(`UPDATE task_instances SET historical_inferred_date = true, historical_inferred_at = now()`)).rejects.toThrow(/permission denied/);
      await expect(app2.query(`UPDATE site_gate_state SET historical_open_override = gen_random_uuid(), historical_open_at = now()`)).rejects.toThrow(/permission denied/);
      // pmis_app reads the gate through gate_eval, as before
      await expect(app2.query(`SELECT status FROM gate_eval(gen_random_uuid(), 'G3')`)).resolves.toBeTruthy();
    } finally {
      await app2.end();
    }
    // a marker in a GUC is not enough: a role that may write the rows (a throwaway role with the table rights, row security bypassed) with both markers set is
    // refused (by the guard of the gate, and for a task already by the backstop of task_instances); so is the definer owner without them
    const ms3 = (await tasks(stuck.id)).MS3!.id;
    const ms2 = (await tasks(stuck.id)).MS2!.id;
    const oid = (await q<{ id: string }>(db, `SELECT id::text AS id FROM admin_overrides WHERE kind = 'historical_gate_open' LIMIT 1`))[0]!.id;
    for (const role of ['hgd_forger', 'pmis_definer']) {
      for (const sql of [`UPDATE task_instances SET historical_inferred_date = true, historical_inferred_at = now() WHERE id = '${ms2}'`,
        `UPDATE site_gate_state SET historical_open_override = '${oid}', historical_open_at = now() WHERE site_id = '${stuck.id}' AND gate_code = 'G3'`]) {
        await db.query('BEGIN');
        try {
          if (role === 'hgd_forger') {
            await db.query('CREATE ROLE hgd_forger NOLOGIN BYPASSRLS');
            await db.query('GRANT SELECT, UPDATE ON task_instances, site_gate_state TO hgd_forger');
            await db.query(`SELECT set_config('pmis.hgd_task', $1, true), set_config('pmis.hgd_gate', $2, true)`, [ms2, `${stuck.id}:G3`]);
          }
          await db.query(`SET LOCAL ROLE ${role}`);
          await expect(db.query(sql)).rejects.toThrow(role === 'hgd_forger' && sql.startsWith('UPDATE task_instances')
            ? /written only through wf_\* functions|written only by GSDN Workspace/ : /written only by GSDN Workspace/);
        } finally {
          await db.query('ROLLBACK');
        }
      }
    }
    expect((await tasks(stuck.id)).MS3!.id).toBe(ms3);
  });
});
