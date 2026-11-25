import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import type { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, startApp, superDbHmm } from './helpers';
import { day } from './tpl-helpers';
import { SITE_ENTRY_GRANTS } from './tpl-stream-helpers';
import { Actor, Site, actor, makeSite, makeTask, plainAdmin } from './wf-helpers';

/**
 * Migration 0129 (owner decision "Option 2", 2026-11-19): on a site of a historical Master load approved directly, a manual milestone (Site RFI, MS4) that the
 * site moved past (a later task approved with an actual date) is approved directly with its pre-filled date, or with none, with the date of the earliest
 * later task approved (inferred), as an admin override of kind historical_manual_ms_approved; it runs in the settle loop of 0127, in the catch-up and at the
 * end of every historical load approved directly; the revert door takes it back (open with its pre-filled date) and it is never applied again; a live site, a
 * Site RFI a person submitted or a date a person typed is never touched. The historical path sends no per-task notice; the normal path still does. Its own
 * database (TEST_DATABASE_URL_HMM): the catch-up reads every site of a historical load. Synthetic data only. Region 3.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 3;
const REASON = 'Historical Master of the owner, with direct approval';

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_HMM as string });
  db = await superDbHmm();
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

interface TaskRow { id: string; code: string; state: string; hmm: boolean; inferred: boolean; override: boolean; actual_date: string | null }
const tasks = async (siteId: string): Promise<Record<string, TaskRow>> => Object.fromEntries((await q<TaskRow>(db,
  `SELECT t.id::text AS id, td.code, t.state::text AS state, t.historical_manual_ms AS hmm, t.historical_manual_ms_inferred AS inferred,
          t.admin_override AS override, t.actual_date::text AS actual_date
   FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id WHERE t.site_id = $1`, [siteId])).map((r) => [r.code, r]));
const audits = async (action: string, siteId: string) => (await q<{ n: number }>(db,
  'SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND site_id = $2', [action, siteId]))[0]!.n;
const stage = async (siteId: string) => (await q<{ s: string }>(db, 'SELECT hns_current_stage($1) AS s', [siteId]))[0]!.s;
const gate = async (siteId: string, g: string) => (await q<{ status: string }>(db, 'SELECT status FROM gate_eval($1, $2)', [siteId, g]))[0]!.status;
const overrides = async (siteId: string) => q<{ id: string; task_id: string; before: Record<string, any>; after: Record<string, any>; reverted: boolean; acted_by: string }>(db,
  `SELECT id::text AS id, task_id::text AS task_id, before, after, reverted_at IS NOT NULL AS reverted, acted_by::text AS acted_by FROM admin_overrides
   WHERE site_id = $1 AND kind = 'historical_manual_ms_approved' ORDER BY created_at`, [siteId]);
const notices = async (siteId: string) => (await q<{ n: number }>(db,
  'SELECT count(*)::int AS n FROM notifications n JOIN task_instances t ON t.id = n.task_id WHERE t.site_id = $1', [siteId]))[0]!.n;
const catchUp = async () => (await q<{ r: Record<string, any> }>(db, 'SELECT hmm_catch_up() AS r'))[0]!.r;

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
/** Site RFI pre-filled as the calculation leaves it (Q38): the date and values.prefilled_date. */
async function prefill(siteId: string, date: string, typed?: string): Promise<void> {
  await db.query(`UPDATE task_instances t SET actual_date = $3::date, values = coalesce(t.values, '{}'::jsonb) || jsonb_build_object('prefilled_date', $2::text, 'prefilled', true)
    FROM task_definitions td WHERE td.id = t.task_def_id AND td.code = 'MS4' AND t.site_id = $1`, [siteId, date, typed ?? date]);
}
const throughCw: Spec[] = [
  ['A1', 'approved', '2026-01-02'], ['A2', 'approved', '2026-01-04'], ['A3', 'approved', '2026-01-05'], ['A4', 'approved', '2026-01-06'], ['A5', 'na'],
  ['MS1', 'approved', '2026-01-06'],
  ['B1', 'approved', '2026-01-10'], ['B2', 'approved', '2026-01-11'], ['B3', 'approved', '2026-01-12'], ['B4', 'approved', '2026-01-13'],
  ['B5', 'approved', '2026-01-14'], ['B6', 'approved', '2026-01-15'], ['B7', 'approved', '2026-01-16'], ['MS2', 'open'],
  ['B8', 'approved', '2026-02-01'], ['B9', 'approved', '2026-02-02'], ['B10', 'approved', '2026-02-05'], ['B11', 'approved', '2026-02-06'], ['MS3', 'locked'],
  ['B13', 'locked'], ['C1', 'na'], ['C2', 'na'], ['C3', 'na'], ['C4', 'na'], ['MS4', 'locked'],
];
/** Through CW Completion approved, Site RFI pre-filled on 2026-03-01 (from B13). */
const cwDone: Spec[] = [
  ['MS1', 'approved', '2026-01-06'], ['MS2', 'approved', '2026-01-16'], ['B11', 'approved', '2026-02-06'], ['MS3', 'approved', '2026-02-06'],
  ['B13', 'approved', '2026-03-01'], ['C2', 'na'], ['C4', 'na'], ['MS4', 'open'],
];
const teLocked: Spec[] = [['D1', 'locked'], ['D2', 'locked'], ['D3', 'locked'], ['D4', 'locked'], ['D4b', 'locked'], ['D5', 'locked'], ['D6', 'locked'], ['MS5', 'locked']];

describe('0129: a Site RFI the site moved past is approved directly with its pre-filled date (historical load)', () => {
  let admin: Actor;
  let loaded: Site; let noDate: Site; let lockedReady: Site; let typed: Site; let review: Site; let idle: Site; let live: Site;

  it('(a) the historical load: Site RFI pre-filled, the TE work approved later: approved directly with the pre-filled date; G5 and TE Completion follow; no notice', async () => {
    admin = await plainAdmin(app, db);
    loaded = await build('HMA', [...throughCw, ...teLocked]);
    await db.query(`UPDATE task_instances t SET lock_reason = 'gate_closed:G3' FROM task_definitions td WHERE td.id = t.task_def_id AND td.code = 'MS3' AND t.site_id = $1`, [loaded.id]);
    const before = await notices(loaded.id);
    const runId = await load(admin, await masterFile([{ A: 1, B: loaded.code, BV: day('2026-03-01'), CC: day('2026-03-10'), CJ: day('2026-03-20'), CS: day('2026-03-25') }]));

    const t = await tasks(loaded.id);
    expect(t.MS3).toMatchObject({ state: 'approved', actual_date: '2026-02-06' });
    expect(t.MS4).toMatchObject({ state: 'approved', actual_date: '2026-03-01', hmm: true, inferred: false, override: true });
    expect(await gate(loaded.id, 'G5')).toBe('open');
    expect(t.MS5).toMatchObject({ state: 'approved', actual_date: '2026-03-25', hmm: false });
    expect(await stage(loaded.id)).toBe('done');

    const ov = await overrides(loaded.id);
    expect(ov).toHaveLength(1);
    expect(ov[0]).toMatchObject({ task_id: t.MS4!.id, reverted: false, acted_by: admin.user.id,
      before: { state: 'open', actual_date: '2026-03-01', prefilled_date: '2026-03-01' },
      after: { state: 'approved', actual_date: '2026-03-01', date_source: 'prefilled', evidence_task: 'D2', evidence_date: '2026-03-10' } });
    const au = await q<{ after: Record<string, any>; is_admin_override: boolean; reason: string; actor_id: string }>(db,
      `SELECT after, is_admin_override, reason, actor_id::text AS actor_id FROM audit_log WHERE action = 'task_historical_manual_ms_approved' AND entity_id = $1`, [t.MS4!.id]);
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({ is_admin_override: true, reason: REASON, actor_id: admin.user.id,
      after: { historical_manual_ms: true, date_source: 'prefilled', task_code: 'MS4', override_id: ov[0]!.id, evidence_task: 'D2', catch_up: false } });
    const step = await q<{ note: string; before_state: string }>(db,
      `SELECT note, before_state::text AS before_state FROM workflow_steps WHERE task_id = $1 AND action = 'admin_override'`, [t.MS4!.id]);
    expect(step).toHaveLength(1);
    expect(step[0]).toMatchObject({ before_state: 'open' });
    expect(step[0]!.note).toContain('pre-filled date approved directly');
    const sum = await q<{ after: Record<string, any> }>(db, `SELECT after FROM audit_log WHERE action = 'historical_gates_dates_apply' AND entity_id = $1`, [runId]);
    expect(sum).toHaveLength(1);
    expect(sum[0]!.after).toMatchObject({ manual_ms_approved: 1, manual_ms_approved_by_code: { MS4: 1 }, manual_ms_inferred: 0, gates_opened_by_gate: { G3: 1, G5: 1 },
      current_stage_after: { done: 1 } });
    // the direct approval and the rules opened tasks on this site (B13, MS4, D1 ...) without a single notice
    expect(await notices(loaded.id)).toBe(before);
    // the task screen lists the override as revertible
    const detail = await admin.api.call('get', `/tasks/${t.MS4!.id}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.overrides).toEqual(expect.arrayContaining([expect.objectContaining({ id: ov[0]!.id, kind: 'historical_manual_ms_approved', revertible: true })]));
  });

  it('(b) no pre-filled date (every predecessor N/A): the inferred date (earliest later task approved), flagged; the successor opens without a notice', async () => {
    noDate = await build('HMB', [['MS1', 'na'], ['MS2', 'na'], ['MS3', 'na'], ['B13', 'na'], ['C2', 'na'], ['C4', 'na'], ['MS4', 'open'], ['D1', 'locked'], ['MOB-5', 'approved', '2026-04-05']]);
    await markHistorical(admin, noDate.id, 'MOB-5');
    // (c) locked but ready: its predecessors approved, no gate holds it, no pre-filled date yet: approved with the date the calculation gives (the latest condition)
    lockedReady = await build('HMC', [['MS3', 'approved', '2026-04-20'], ['B13', 'approved', '2026-05-01'], ['C2', 'na'], ['C4', 'na'], ['MS4', 'locked'],
      ['D1', 'approved', '2026-05-08'], ['D2', 'approved', '2026-05-10']]);
    await markHistorical(admin, lockedReady.id, 'D2');
    const before = await notices(noDate.id);
    const out = await catchUp();
    expect(out).toMatchObject({ catch_up: true });
    expect(out.manual_ms_approved_by_code.MS4).toBeGreaterThanOrEqual(2);
    expect(out.manual_ms_inferred).toBeGreaterThanOrEqual(1);
    const t = await tasks(noDate.id);
    expect(t.MS4).toMatchObject({ state: 'approved', actual_date: '2026-04-05', hmm: true, inferred: true, override: true });
    expect(t.D1!.state).toBe('open');
    expect(await notices(noDate.id)).toBe(before);
    const ov = await overrides(noDate.id);
    expect(ov[0]).toMatchObject({ after: { date_source: 'inferred', actual_date: '2026-04-05', note: 'inferred date — historical load', evidence_task: 'MOB-5' } });
    const au = await q<{ actor_id: string; after: Record<string, any> }>(db,
      `SELECT actor_id::text AS actor_id, after FROM audit_log WHERE action = 'task_historical_manual_ms_approved' AND site_id = $1`, [noDate.id]);
    expect(au[0]).toMatchObject({ actor_id: admin.user.id, after: { historical_manual_ms_inferred: true, catch_up: true } });   // as the System Admin who loaded it
    const sum = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'historical_manual_ms_catch_up'`);
    expect(sum[0]!.n).toBeGreaterThanOrEqual(2);   // the migration's own run, and this one

    expect((await tasks(lockedReady.id)).MS4).toMatchObject({ state: 'approved', actual_date: '2026-05-01', hmm: true, inferred: false });
    expect((await overrides(lockedReady.id))[0]).toMatchObject({ before: { state: 'locked' }, after: { date_source: 'prefilled', evidence_task: 'D1' } });
  });

  it('(d) untouched: no later work, a date a person typed, a Site RFI a person submitted, a live site', async () => {
    idle = await build('HMI', [...cwDone, ['D1', 'locked']]);
    await prefill(idle.id, '2026-03-01');
    await markHistorical(admin, idle.id, 'B13');
    typed = await build('HMT', [...cwDone, ['D1', 'approved', '2026-03-05'], ['D2', 'approved', '2026-03-10']]);
    await prefill(typed.id, '2026-03-01', '2026-03-03');
    await markHistorical(admin, typed.id, 'D2');
    review = await build('HMR', [...cwDone.filter(([c]) => c !== 'MS4'), ['MS4', 'in_review', '2026-03-01'], ['D1', 'approved', '2026-03-05'], ['D2', 'approved', '2026-03-10']]);
    await markHistorical(admin, review.id, 'D2');
    live = await build('HML', [...cwDone, ['D1', 'approved', '2026-03-05'], ['D2', 'approved', '2026-03-10']]);
    await prefill(live.id, '2026-03-01');
    const out = await catchUp();
    expect((await tasks(idle.id)).MS4).toMatchObject({ state: 'open', actual_date: '2026-03-01', hmm: false });
    expect(out.waiting_after.MS4).toMatchObject({ 'the pre-filled date waits for its L2 approval': 2, 'the milestone is in_review': 1 });   // idle and typed; review
    expect((await tasks(typed.id)).MS4).toMatchObject({ state: 'open', actual_date: '2026-03-03', hmm: false });
    expect((await tasks(review.id)).MS4).toMatchObject({ state: 'in_review', actual_date: '2026-03-01', hmm: false });
    expect((await tasks(live.id)).MS4).toMatchObject({ state: 'open', actual_date: '2026-03-01', hmm: false, override: false });
    for (const s of [idle, typed, review, live]) {
      expect(await overrides(s.id)).toHaveLength(0);
      expect(await audits('task_historical_manual_ms_approved', s.id)).toBe(0);
    }
  });

  it('(e) idempotent: the catch-up again and the same file again change nothing', async () => {
    const n = async () => (await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM admin_overrides WHERE kind = 'historical_manual_ms_approved'`))[0]!.n;
    const before = await n();
    const again = await catchUp();
    expect(again).toMatchObject({ manual_ms_approved: 0, gates_opened: 0, milestones_inferred: 0, tasks_na: 0 });
    await load(admin, await masterFile([{ A: 1, B: loaded.code, BV: day('2026-03-01'), CC: day('2026-03-10'), CJ: day('2026-03-20'), CS: day('2026-03-25') }]), true);
    expect(await n()).toBe(before);
    expect((await tasks(loaded.id)).MS4).toMatchObject({ state: 'approved', actual_date: '2026-03-01', hmm: true });
  });

  it('(f) revert through POST /overrides/{id}/revert: System Admin with a reason and a step-up; open with its pre-filled date; never applied again', async () => {
    const pre = (await overrides(loaded.id))[0]!;
    const inf = (await overrides(noDate.id))[0]!;
    const clerk = await actor(app, db, { level: 'entry', grants: SITE_ENTRY_GRANTS, regions: [R], modules: null });
    expect([403, 404]).toContain((await clerk.api.call('post', `/overrides/${pre.id}/revert`, { reason: 'Not an admin' })).status);
    const noStep = await plainAdmin(app, db, false);
    expect((await noStep.api.call('post', `/overrides/${pre.id}/revert`, { reason: 'No step-up' })).status).toBe(401);

    const r1 = await admin.api.call('post', `/overrides/${pre.id}/revert`, { reason: 'The team will submit Site RFI for L2' });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body).toMatchObject({ kind: 'historical_manual_ms_approved', revertible: false });
    expect(r1.body.reverted_at).toBeTruthy();
    let t = await tasks(loaded.id);
    expect(t.MS4).toMatchObject({ state: 'open', actual_date: '2026-03-01', hmm: false, inferred: false, override: false });
    expect(t.MS5!.state).toBe('approved');   // what followed is never taken back (as 0127)
    expect(await audits('task_historical_manual_ms_restore', loaded.id)).toBe(1);
    const st = await q<{ action: string }>(db, `SELECT action::text AS action FROM workflow_steps WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`, [t.MS4!.id]);
    expect(st[0]!.action).toBe('override_revert');
    expect((await admin.api.call('post', `/overrides/${pre.id}/revert`, { reason: 'Again' })).status).toBe(409);

    const r2 = await admin.api.call('post', `/overrides/${inf.id}/revert`, { reason: 'The team has the real Site RFI date' });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect((await tasks(noDate.id)).MS4).toMatchObject({ state: 'open', actual_date: null, hmm: false, inferred: false });

    // never applied again: the catch-up and a re-apply leave both as the admin left them
    const out = await catchUp();
    expect(out.manual_ms_approved).toBe(0);
    await load(admin, await masterFile([{ A: 1, B: loaded.code, BV: day('2026-03-01'), CC: day('2026-03-10'), CJ: day('2026-03-20'), CS: day('2026-03-25') }]), true);
    t = await tasks(loaded.id);
    expect(t.MS4).toMatchObject({ state: 'open', actual_date: '2026-03-01', hmm: false });
    expect((await tasks(noDate.id)).MS4).toMatchObject({ state: 'open', hmm: false });
  });

  it('(g) the normal path still notifies: a task opened outside the historical path sends its notice', async () => {
    const t = await tasks(live.id);
    const before = await notices(live.id);
    await db.query(`UPDATE task_instances SET state = 'locked', current_level = 0 WHERE id = $1`, [t.D1!.id]);
    await db.query(`SELECT wf_open_locked($1, 'test: the normal path')`, [t.D1!.id]);
    expect(await notices(live.id)).toBeGreaterThan(before);
    // a session setting named like the old marker mutes nothing
    const b2 = await notices(live.id);
    await db.query('BEGIN');
    try {
      await db.query(`SELECT set_config('pmis.hda_quiet', $1, true)`, [t.D1!.id]);
      await db.query(`UPDATE task_instances SET state = 'locked', current_level = 0 WHERE id = $1`, [t.D1!.id]);
      await db.query(`SELECT wf_open_locked($1, 'test: a forged setting')`, [t.D1!.id]);
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
    expect(await notices(live.id)).toBeGreaterThan(b2);
  });

  it('(h) the application role cannot reach the internal functions, the markers or the flags; a forged marker is refused', async () => {
    const app2 = new (await import('pg')).Client({ connectionString: process.env.TEST_DATABASE_URL_HMM });
    await app2.connect();
    try {
      for (const sql of [`SELECT hmm_catch_up()`, `SELECT hmm_restore_task(gen_random_uuid(), gen_random_uuid(), 'x', 'x', true)`,
        `SELECT hgd_mark('hist_quiet', 'x')`, `SELECT hgd_unmark('hist_quiet')`, `INSERT INTO hgd_marks (xid, kind, key) VALUES (txid_current(), 'hist_quiet', 'x')`]) {
        await expect(app2.query(sql)).rejects.toThrow(/permission denied/);
      }
      await expect(app2.query(`UPDATE task_instances SET historical_manual_ms = true, historical_manual_ms_at = now()`)).rejects.toThrow(/permission denied/);
    } finally {
      await app2.end();
    }
    const ms4 = (await tasks(idle.id)).MS4!.id;
    for (const role of ['hmm_forger', 'pmis_definer']) {
      await db.query('BEGIN');
      try {
        if (role === 'hmm_forger') {
          await db.query('CREATE ROLE hmm_forger NOLOGIN BYPASSRLS');
          await db.query('GRANT SELECT, UPDATE ON task_instances TO hmm_forger');
          await db.query(`SELECT set_config('pmis.hmm_task', $1, true)`, [ms4]);
        }
        await db.query(`SET LOCAL ROLE ${role}`);
        await expect(db.query(`UPDATE task_instances SET state = 'approved', historical_manual_ms = true, historical_manual_ms_at = now() WHERE id = '${ms4}'`))
          .rejects.toThrow(/written only through wf_\* functions|written only by GSDN Workspace/);
      } finally {
        await db.query('ROLLBACK');
      }
    }
    expect((await tasks(idle.id)).MS4).toMatchObject({ state: 'open', hmm: false });
  });
});
