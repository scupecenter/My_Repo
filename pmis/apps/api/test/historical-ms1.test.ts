import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import type { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q } from './calc-helpers';
import { Api, startApp, superDbHms1 } from './helpers';
import { day } from './tpl-helpers';
import { SITE_APPROVE_GRANTS } from './tpl-stream-helpers';
import { Actor, Site, actor, makeSite, makeTask, plainAdmin, setCell } from './wf-helpers';

/**
 * Migration 0124 (owner request 2026-11-18): Site Release (MS1) of the historical Master load. A3 is read from the Acquisition sheet of the same file as Master
 * column T reads it (the one selected candidate's Contract Sign-off Date) and approved directly as the admin override of the load, also when the Acquisition
 * register refuses the row (no Selection Date in the owner's file, Q468); A5 is N/A on a site whose type is not HUB or Terminal (the rule A5 / flag
 * hub_terminal of Settings, Scenario rules), for every site: the one-time catch-up, a change of the site type and a new site. Its own database
 * (TEST_DATABASE_URL_HMS1): the catch-up reads every Acquisition batch of a historical load and every site of its database. Synthetic data only. Region 4.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 4;
const REASON = 'Historical Master of the owner, Site Release from its sheets';

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_HMS1 as string });
  db = await superDbHms1();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

type Cell = string | number | Date | null;
interface Sheet { name: string; headers: string[]; rows: Cell[][] }

/** A synthetic legacy Master: the Master sheet (three header rows, data from row 5) and the given register sheets (header row 1, data from row 3). */
async function masterFile(masterRows: Record<string, Cell>[], sheets: Sheet[]): Promise<Buffer> {
  const cols = await q<{ letter: string; group_top: string | null; group_mid: string | null; name: string | null }>(db, 'SELECT letter, group_top, group_mid, name FROM master_columns WHERE is_active ORDER BY ord');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Guide').getCell('A1').value = 'Guide';
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
const openWaiver = async (a: Actor) => {
  const r = await a.api.call('put', '/settings/historical-waiver', { open: true, cutoff_date: '2026-06-30', reason: 'Open for the historical load' });
  expect([200, 409]).toContain(r.status);
};
interface TaskRow { code: string; state: string; flag: boolean; batch: string | null; actual_date: string | null; approves: number; na_reason: string | null }
const tasks = async (siteId: string): Promise<Record<string, TaskRow>> => Object.fromEntries((await q<TaskRow>(db,
  `SELECT td.code, t.state::text AS state, t.historical_direct_approved AS flag, t.historical_direct_batch_id::text AS batch, t.actual_date::text AS actual_date,
     (SELECT count(*)::int FROM workflow_steps w WHERE w.task_id = t.id AND w.action = 'approve') AS approves, t.na_reason
   FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id WHERE t.site_id = $1`, [siteId])).map((r) => [r.code, r]));
const audits = async (action: string, siteId: string) => (await q<{ n: number }>(db,
  'SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND site_id = $2', [action, siteId]))[0]!.n;
const status = async (siteId: string) => (await q<{ s: string }>(db, 'SELECT overall_status::text AS s FROM sites WHERE id = $1', [siteId]))[0]!.s;
/** The site type as a site created before migration 0124 holds it (the trigger of 0124 off, as the catch-up finds the data). */
const setTypeQuietly = async (s: Site, type: string | null) => {
  await db.query('SET session_replication_role = replica');
  try {
    await db.query('UPDATE sites SET site_type = $2 WHERE id = $1', [s.id, type]);
  } finally {
    await db.query('SET session_replication_role = origin');
  }
};
/** The Design & Acquisition tasks of a site that waits for Site Release. */
async function stage1(prefix: string, states: Partial<Record<'A2' | 'A3' | 'A4' | 'A5', [string, string | null]>> = {}): Promise<Site> {
  const s = await makeSite(db, R, { prefix, status: 'not_started' });
  await makeTask(db, s, 'A1', 'open');   // no source in the file; not a predecessor of Site Release
  for (const c of ['A2', 'A3', 'A4', 'A5'] as const) {
    const [st, d] = states[c] ?? ['locked', null];
    await makeTask(db, s, c, st, { actualDate: d });
  }
  await makeTask(db, s, 'MS1', 'locked');
  await makeTask(db, s, 'B1', 'locked');
  return s;
}

const RF = ['#', 'Site ID', 'TSSR Approved', 'LLD Approved Date', 'MW LOS Survey Date', 'Link Budget Date'];
const ACQ = ['#', 'Site ID', 'Candidate', 'Selected', 'Contract Sign-off Date'];

describe('0124: A5 follows the site type (HUB / Terminal only)', () => {
  it('the rule is in Settings, Scenario rules; the catch-up makes A5 N/A on a Core site, keeps it on a HUB site and on a site without a type; MS1 completes; idempotent', async () => {
    const admin = await plainAdmin(app, db);
    const rules = await admin.api.call('get', '/settings/scenario-rules');
    expect(rules.status).toBe(200);
    expect(rules.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ task_code: 'A5', scenario: null, rule: 'flag', flag_expr: 'hub_terminal' }),
      expect.objectContaining({ task_code: 'A5', scenario: 'expansion', rule: 'na' }),   // a scenario rule still wins
    ]));
    const done: Partial<Record<'A2' | 'A3' | 'A4' | 'A5', [string, string | null]>> = {
      A2: ['approved', '2026-01-08'], A3: ['approved', '2026-01-20'], A4: ['approved', '2026-01-12'] };
    const core = await stage1('HMC', done);
    const hub = await stage1('HMH', done);
    const none = await stage1('HMN', done);
    const coreA5Done = await stage1('HMD', { ...done, A5: ['approved', '2026-01-15'] });
    const coreOpen = await stage1('HMO');
    await setTypeQuietly(core, 'Core');
    await setTypeQuietly(hub, 'HUB');
    await setTypeQuietly(coreA5Done, 'FN');
    await setTypeQuietly(coreOpen, ' mfn ');
    expect((await tasks(core.id)).A5!.state).toBe('locked');

    const out = (await q<{ r: Record<string, any> }>(db, 'SELECT hms_catch_up() AS r'))[0]!.r;
    expect(out.site_type_rules.tasks_na).toBeGreaterThanOrEqual(2);
    expect(out.site_type_rules.tasks_site_type_unknown).toBeGreaterThanOrEqual(1);
    expect(out.site_type_rules.tasks_kept_in_progress_or_approved).toBeGreaterThanOrEqual(1);   // the approved A5 of the FN site is kept
    const tc = await tasks(core.id);
    expect(tc.A5).toMatchObject({ state: 'na' });
    expect(tc.A5!.na_reason).toMatch(/^applicability: A5 .*HUB and Terminal/);
    // Site Release completes with the dates of A2, A3 and A4; the overall status follows
    expect(tc.MS1).toMatchObject({ state: 'approved', actual_date: '2026-01-20' });
    expect(await status(core.id)).toBe('in_progress');
    expect((await tasks(coreOpen.id)).A5!.state).toBe('na');   // the type is read without case and spaces
    // a HUB site still needs A5; a site without a type keeps it as it is (counted); an approved A5 is never touched
    expect((await tasks(hub.id)).A5!.state).toBe('locked');
    expect((await tasks(hub.id)).MS1!.state).toBe('locked');
    expect((await tasks(none.id)).A5!.state).toBe('locked');
    expect((await tasks(coreA5Done.id)).A5).toMatchObject({ state: 'approved', actual_date: '2026-01-15' });
    // one audit row per task, with the site type; one summary row
    const au = await q<{ after: Record<string, any>; reason: string }>(db,
      `SELECT after, reason FROM audit_log WHERE action = 'task_applicability_na' AND site_id = $1`, [core.id]);
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({ after: { state: 'na', source: 'flag', site_type: 'Core' } });
    expect(au[0]!.reason).toMatch(/^migration 0124/);
    const sum = await q<{ after: Record<string, any>; is_admin_override: boolean }>(db,
      `SELECT after, is_admin_override FROM audit_log WHERE action = 'historical_ms1_catch_up' ORDER BY id DESC LIMIT 1`);
    expect(sum[0]).toMatchObject({ is_admin_override: true, after: { site_type_rules: { tasks_na: out.site_type_rules.tasks_na } } });
    // a second run changes nothing
    const again = (await q<{ r: Record<string, any> }>(db, 'SELECT hms_catch_up() AS r'))[0]!.r;
    expect(again.site_type_rules).toMatchObject({ tasks_na: 0, tasks_restored: 0, sites_changed: 0 });
    expect(await audits('task_applicability_na', core.id)).toBe(1);
  });

  it('a change of the site type applies the rule at once (N/A, then applicable again), a new site reads it, and the site type is no scope conflict', async () => {
    const admin = await plainAdmin(app, db);
    const s = await stage1('HMT', { A2: ['approved', '2026-02-02'] });
    await db.query(`UPDATE task_instances t SET state = 'open', current_level = 1 FROM task_definitions td WHERE td.id = t.task_def_id AND td.code = 'A5' AND t.site_id = $1`, [s.id]);
    await db.query(`UPDATE sites SET site_type = 'HUB' WHERE id = $1`, [s.id]);
    expect((await tasks(s.id)).A5!.state).toBe('open');
    await db.query(`UPDATE sites SET site_type = 'MFN' WHERE id = $1`, [s.id]);
    expect((await tasks(s.id)).A5).toMatchObject({ state: 'na' });
    const na = await q<{ reason: string }>(db, `SELECT reason FROM audit_log WHERE action = 'task_applicability_na' AND site_id = $1`, [s.id]);
    expect(na[0]!.reason).toMatch(/site type changed \(HUB -> MFN\)/);
    await db.query(`UPDATE sites SET site_type = 'Terminal' WHERE id = $1`, [s.id]);
    expect((await tasks(s.id)).A5!.state).toBe('open');   // its predecessor A2 is approved: it opens again
    expect(await audits('task_applicability_restore', s.id)).toBe(1);
    // no site type: the rule says nothing, A5 keeps its state
    await db.query(`UPDATE sites SET site_type = NULL WHERE id = $1`, [s.id]);
    expect((await tasks(s.id)).A5!.state).toBe('open');

    // the applicability screen shows the rule (source flag); a new site takes it from its first applicability (site_create_apply reads site_task_rule)
    await db.query(`UPDATE sites SET site_type = 'Core' WHERE id = $1`, [s.id]);
    const ap = await admin.api.call('get', `/sites/${s.id}/applicability`);
    expect(ap.status).toBe(200);
    expect((ap.body.tasks as { task_code: string; applies: boolean | null; source: string }[]).find((x) => x.task_code === 'A5'))
      .toMatchObject({ applies: false, source: 'flag' });
    // an Expansion HUB site: the scenario makes A5 N/A, the site type would apply it; the scenario wins and this is no scope conflict
    const ex = await makeSite(db, R, { prefix: 'HMX', scenario: 'expansion', status: 'not_started' });
    await setTypeQuietly(ex, 'HUB');
    const rule = (await q<{ applies: boolean; source: string }>(db, `SELECT applies, source FROM site_task_rule($1, 'A5')`, [ex.id]))[0]!;
    expect(rule).toMatchObject({ applies: false, source: 'scenario' });
    expect((await q<{ c: unknown[] }>(db, 'SELECT scope_scenario_conflicts($1) AS c', [ex.id]))[0]!.c).toEqual([]);

    // Settings: the expression is accepted in the list (the round trip of the screen), an unknown one is refused
    const res = await admin.api.call('get', '/settings/scenario-rules');
    const list = res.body.items.map((r: Record<string, unknown>) => ({ task_code: r.task_code, scenario: r.scenario, rule: r.rule, flag_expr: r.flag_expr, reason: r.reason }));
    const bad = await admin.api.call('put', '/settings/scenario-rules', { reason: 'synthetic check', rules: [...list.filter((r: { task_code: string }) => r.task_code !== 'A5'),
      { task_code: 'A5', scenario: null, rule: 'flag', flag_expr: 'site_type', reason: 'unknown expression' }] }, { 'If-Match': String(res.headers.etag) });
    expect(bad.status).toBe(422);
    const ok = await admin.api.call('put', '/settings/scenario-rules', { reason: 'synthetic check', rules: list }, { 'If-Match': String(res.headers.etag) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ task_code: 'A5', rule: 'flag', flag_expr: 'hub_terminal' })]));
  });
});

describe('0124: A3 from the Acquisition sheet of the historical load (Master T)', () => {
  it('a historical re-apply approves A3 directly with the selected candidate\'s date, A5 is N/A on the Core site and loaded on the HUB site, MS1 completes for both; idempotent', async () => {
    const admin = await plainAdmin(app, db);
    const approver = await actor(app, db, { level: 'approve', grants: SITE_APPROVE_GRANTS, regions: [R], modules: null });
    for (const c of ['A2', 'A4', 'A5']) {
      await setCell(db, c, R, 'entry', { user: [admin.user.id] });
      await setCell(db, c, R, 'approve', { user: [approver.user.id] });
    }
    const core = await stage1('HLC');
    const hub = await stage1('HLH');
    const two = await stage1('HL2');   // two selected candidates: Master T is blank, nothing is approved
    await db.query(`UPDATE sites SET site_type = 'Core' WHERE id = $1`, [core.id]);   // the trigger: A5 N/A at once
    await db.query(`UPDATE sites SET site_type = 'HUB' WHERE id = ANY ($1::uuid[])`, [[hub.id, two.id]]);
    expect((await tasks(core.id)).A5!.state).toBe('na');
    await openWaiver(admin);
    const file = await masterFile([{ A: 1, B: core.code }, { A: 2, B: hub.code }, { A: 3, B: two.code }], [
      { name: 'RF & Design', headers: RF, rows: [
        [1, core.code, day('2026-01-08'), day('2026-01-12'), null, null],
        [2, hub.code, day('2026-01-09'), day('2026-01-13'), day('2026-01-25'), day('2026-01-27')],
      ] },
      // the owner's file has no Selection Date column: the register refuses a selected candidate (Q468); Master T still reads its Contract Sign-off Date
      { name: 'Acquisition', headers: ACQ, rows: [
        [1, core.code, 'A', 'Yes', day('2026-01-20')],
        [2, core.code, 'B', 'No', null],
        [3, hub.code, 'A', 'Yes', day('2026-01-22')],
        [4, two.code, 'A', 'Yes', day('2026-01-21')],
        [5, two.code, 'B', 'Yes', day('2026-01-23')],
      ] },
    ]);
    const run = await uploadMaster(admin.api, file);
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const applied = await admin.api.call('post', `/master-import/runs/${run.body.id}/apply`,
      { mode: 'submit', reason: 'Initial load', historical_load: { reason: REASON, approve_directly: true, registers: true } }, { 'If-Match': `"${run.body.version}"` });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const batches = applied.body.outcome.batches as { id: string; kind: string; ref: string; approved: number; errors: number }[];
    const acq = batches.find((b) => b.ref === 'acquisition')!;
    expect(acq, JSON.stringify(batches)).toBeDefined();
    const refused = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM import_batch_rows r, jsonb_array_elements(r.errors) e
      WHERE r.batch_id = $1 AND r.action = 'error' AND e ->> 'field' = 'selection_date'`, [acq.id]);
    expect(refused[0]!.n).toBeGreaterThanOrEqual(2);   // the register still refuses the selected rows

    const tc = await tasks(core.id);
    expect(tc.A3).toMatchObject({ state: 'approved', flag: true, batch: acq.id, actual_date: '2026-01-20', approves: 1 });
    expect(tc.A2).toMatchObject({ state: 'approved', flag: true, actual_date: '2026-01-08' });
    expect(tc.A4).toMatchObject({ state: 'approved', flag: true, actual_date: '2026-01-12' });
    expect(tc.A5).toMatchObject({ state: 'na' });
    expect(tc.MS1).toMatchObject({ state: 'approved', actual_date: '2026-01-20' });
    const th = await tasks(hub.id);
    expect(th.A3).toMatchObject({ state: 'approved', flag: true, batch: acq.id, actual_date: '2026-01-22', approves: 1 });
    expect(th.A5).toMatchObject({ state: 'approved', flag: true, actual_date: '2026-01-27' });   // the later of MW LOS and link budget (0122)
    expect(th.MS1).toMatchObject({ state: 'approved', actual_date: '2026-01-27' });
    expect(await status(core.id)).toBe('in_progress');
    expect(await status(hub.id)).toBe('in_progress');
    const t2 = await tasks(two.id);
    expect(t2.A3).toMatchObject({ flag: false, actual_date: null, approves: 0 });
    expect(t2.A3!.state).not.toBe('approved');
    expect(t2.MS1!.state).toBe('locked');

    // the audit rows: one per task (admin override, the loader, the reason of the load, the batch row, Master T); one per batch with the counts
    const a3id = (await q<{ id: string }>(db, `SELECT t.id::text AS id FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id WHERE td.code = 'A3' AND t.site_id = $1`, [core.id]))[0]!.id;
    const au = await q<{ after: Record<string, any>; reason: string; is_admin_override: boolean; actor_id: string }>(db,
      `SELECT after, reason, is_admin_override, actor_id::text AS actor_id FROM audit_log WHERE action = 'task_historical_direct_approval' AND entity_id = $1`, [a3id]);
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({ is_admin_override: true, reason: REASON, actor_id: admin.user.id,
      after: { historical_direct_approved: true, register_key: 'acquisition', task_code: 'A3', source_field: 'contract_signoff_date', master_column: 'T', catch_up: false } });
    const step = await q<{ note: string }>(db, `SELECT note FROM workflow_steps WHERE task_id = $1 AND action = 'approve'`, [a3id]);
    expect(step[0]!.note).toMatch(/^historical load: approved directly with the Acquisition sheet \(Master T/);
    const ba = await q<{ after: Record<string, any> }>(db, `SELECT after FROM audit_log WHERE action = 'import_batch.historical_acquisition_tasks' AND entity_id = $1`, [acq.id]);
    expect(ba).toHaveLength(1);
    expect(ba[0]!.after).toMatchObject({ sites: 3, approved_by_task: { A3: 2 }, outcomes: { approved: 2, several_rows: 1 } });

    // the same file again (re-apply) and the catch-up: nothing is approved twice
    const n = [await audits('task_historical_direct_approval', core.id), await audits('task_historical_direct_approval', hub.id)];
    const r2 = await uploadMaster(admin.api, file);
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    const again = await admin.api.call('post', `/master-import/runs/${r2.body.id}/apply`,
      { mode: 'submit', reason: 'Again', historical_load: { reason: REASON, approve_directly: true, registers: true, reapply: true } }, { 'If-Match': `"${r2.body.version}"` });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const cu = (await q<{ r: Record<string, any> }>(db, 'SELECT hms_catch_up() AS r'))[0]!.r;
    expect(cu.a3.approved_by_task).toEqual({});
    expect([await audits('task_historical_direct_approval', core.id), await audits('task_historical_direct_approval', hub.id)]).toEqual(n);
    for (const [c, row] of Object.entries(await tasks(core.id))) expect(row.approves, c).toBeLessThanOrEqual(1);
  });

  it('the catch-up closes A3 from an Acquisition batch of an earlier historical load, as its loader; a discarded batch is never read', async () => {
    const admin = await plainAdmin(app, db);
    const s = await stage1('HLK', { A2: ['approved', '2026-01-08'], A4: ['approved', '2026-01-12'], A5: ['approved', '2026-01-14'] });
    const d = await stage1('HLX', { A2: ['approved', '2026-01-08'], A4: ['approved', '2026-01-12'], A5: ['approved', '2026-01-14'] });
    const tv = (await q<{ id: string }>(db, `SELECT v.id::text AS id FROM template_versions v JOIN template_definitions dd ON dd.id = v.template_def_id WHERE dd.template_id = 'TPL-ACQUISITION' AND v.is_current`))[0]!.id;
    const batch = async (st: string, site: Site, date: string) => {
      const b = (await q<{ id: string }>(db, `INSERT INTO import_batches (template_version_id, source, file_name, file_sha256, status, uploaded_by, register_key, mode,
          historical_load, historical_cutoff, historical_reason, historical_marked_by, historical_marked_at, historical_direct_approve, closed_at)
        VALUES ($1, 'master_import', 'GSDN_Site_Master.xlsx', repeat('d', 64), $2, $3, 'acquisition', 'submit', true, '2026-06-30', $4, $3, now(), true, now()) RETURNING id::text AS id`,
        [tv, st, admin.user.id, REASON]))[0]!.id;
      await db.query(`INSERT INTO import_batch_rows (batch_id, row_no, sheet, site_code, region_id, site_id, target_entity, action, payload, errors, decision, source_ref)
        VALUES ($1, 3, 'Acquisition', $2, $3, $4, 'acquisition', 'error', $5::jsonb, '[{"field":"selection_date","code":"required"}]'::jsonb, 'pending', 'Acquisition!3')`,
        [b, site.code, R, site.id, JSON.stringify({ data: { candidate: 'A', selected: 'Yes', contract_signoff_date: date }, custom: {} })]);
      return b;
    };
    // as an earlier load left them (fixture rows, triggers off)
    await db.query('SET session_replication_role = replica');
    let b1 = '';
    try {
      b1 = await batch('partially_approved', s, '2026-01-19');
      await batch('discarded', d, '2026-01-19');
    } finally {
      await db.query('SET session_replication_role = origin');
    }
    const out = (await q<{ r: Record<string, any> }>(db, 'SELECT hms_catch_up() AS r'))[0]!.r;
    expect(out.a3.approved_by_task).toMatchObject({ A3: 1 });
    const t = await tasks(s.id);
    expect(t.A3).toMatchObject({ state: 'approved', flag: true, batch: b1, actual_date: '2026-01-19', approves: 1 });
    expect(t.MS1).toMatchObject({ state: 'approved', actual_date: '2026-01-19' });
    const au = await q<{ after: Record<string, any>; actor_id: string }>(db,
      `SELECT after, actor_id::text AS actor_id FROM audit_log WHERE action = 'task_historical_direct_approval' AND site_id = $1`, [s.id]);
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({ actor_id: admin.user.id, after: { catch_up: true, task_code: 'A3' } });
    expect((await tasks(d.id)).A3!.state).toBe('locked');
    const second = (await q<{ r: Record<string, any> }>(db, 'SELECT hms_catch_up() AS r'))[0]!.r;
    expect(second.a3.approved_by_task).toEqual({});
  });

  it('the application role cannot reach the internal functions or write the task flag', async () => {
    const app2 = new (await import('pg')).Client({ connectionString: process.env.TEST_DATABASE_URL_HMS1 });
    await app2.connect();
    try {
      for (const sql of [`SELECT hms_catch_up()`, `SELECT hms_feed_acquisition(gen_random_uuid(), false, 'x')`,
        `SELECT hms_feed_task(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), current_date, 'A3', 'x', true, 'x')`,
        `SELECT hms_apply_type_rules(gen_random_uuid(), 'x')`]) {
        await expect(app2.query(sql)).rejects.toThrow(/permission denied/);
      }
      await expect(app2.query(`UPDATE task_instances SET historical_direct_approved = true`)).rejects.toThrow(/permission denied/);
    } finally {
      await app2.end();
    }
  });
});
