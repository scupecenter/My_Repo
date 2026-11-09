import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { randomBytes } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImportJobsService, type PendingJob } from '../src/templates/import-jobs.service';
import { q } from './calc-helpers';
import { Api, startApp } from './helpers';
import { G } from './reg-helpers';
import { TPL_GRANTS_ENTRY, downloadTemplate, load, uploadFile } from './tpl-helpers';
import { Actor, actor, plainAdmin } from './wf-helpers';

/**
 * Migration 0083 (technical decision of 2026-11-09, contract 0.15.2): an upload with more data rows than imports.async_rows is staged in the background. The
 * request checks the right, the guard, the _tpl sheet, the version and the headers, and what the staging checks before its rows; it answers 202 with the
 * upload in status `parsing` and its progress; each part (or the next rows of a stream part) is a transaction of its own under the uploader's signed context.
 * The same holds for the comparison of a big legacy Master (POST /master-import/runs, status `staging`).
 * The suite runs on its own database (TEST_DATABASE_URL_BGUP): it seeds synthetic sites with every task and changes imports.async_rows to stage the very same
 * file in the request and in the background, then compares the batches, rows, errors and warnings. Region 6 (GM). The runs are driven by hand (autoStart off).
 */
let app: NestExpressApplication;
let db: PgClient;
let jobs: ImportJobsService;
let admin: Actor;
const R = 6;
const SITES = 60;
const TAG = randomBytes(2).toString('hex').toUpperCase();
let codes: string[] = [];

/** Synthetic sites with every task of workflow 1, at progress levels 0 to 5 (approved, then one open stage, then locked); triggers off while loading. */
async function seed(n: number, prefix: string): Promise<string[]> {
  await db.query('BEGIN');
  await db.query('SET LOCAL session_replication_role = replica');
  const r = await db.query(`
    WITH wf AS (SELECT id FROM workflow_definitions WHERE version = 1),
    s AS (
      INSERT INTO sites (site_code, name, region_id, workflow_version_id, delivery_scenario, overall_status, scope_tower_erection, scope_site_adaption, scope_gecol_power, scope_hlc_fiber, scope_te_full, updated_at)
      SELECT $1 || '-' || lpad(i::text, 4, '0'), 'Upload site ' || i, ${R}, (SELECT id FROM wf), 'new_build', 'in_progress', 'yes', 'yes', 'yes', 'yes', 'yes', now()
      FROM generate_series(1, $2::int) i RETURNING id, site_code),
    t AS (
      INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, actual_date, approved_date, updated_at, level_opened_at, level_round)
      SELECT s.id, ${R}, td.id, (CASE WHEN sd.seq <= l.lvl THEN 'approved' WHEN sd.seq = l.lvl + 1 THEN 'open' ELSE 'locked' END)::"TaskState",
        CASE WHEN sd.seq = l.lvl + 1 THEN 1 ELSE 0 END, 3, CASE WHEN sd.seq <= l.lvl THEN DATE '2026-01-01' + sd.seq * 7 END, CASE WHEN sd.seq <= l.lvl THEN DATE '2026-01-01' + sd.seq * 7 END, now(), now(), 1
      FROM s CROSS JOIN LATERAL (SELECT (substr(s.site_code, length(s.site_code) - 3)::int % 6) AS lvl) l
      JOIN task_definitions td ON td.workflow_id = (SELECT id FROM wf) AND td.is_active JOIN stage_definitions sd ON sd.id = td.stage_id
      RETURNING 1)
    SELECT site_code FROM s ORDER BY site_code`, [prefix, n]);
  await db.query('COMMIT');
  return r.rows.map((x: { site_code: string }) => x.site_code);
}

const setAsyncRows = (n: number) => db.query(`UPDATE settings SET value = to_jsonb($1::int) WHERE key = 'imports.async_rows'`, [n]);

interface Col { header: string; kind: string; type: string; derived?: boolean; options?: string[] }

/** The filled TPL-MASTER of the admin: every typed task column of the Master sheet on every seeded site, an As-Built row per site, a sheet GSDN Workspace does not know. */
async function masterFile(api: Api, sites: string[]): Promise<Buffer> {
  const tv = await q<{ columns: { kind: string; sheet: string; columns: Col[] }[] }>(db,
    `SELECT v.columns FROM template_versions v JOIN template_definitions d ON d.id = v.template_def_id WHERE d.template_id = 'TPL-MASTER' AND v.is_current`);
  const cols = tv[0]!.columns.find((p) => p.kind === 'master')!.columns;
  const wb = await load((await downloadTemplate(api, 'TPL-MASTER')).buffer);
  const ws = wb.getWorksheet('Master')!;
  const at = new Map<string, number>();
  for (let c = 1; c <= ws.getRow(1).cellCount; c++) at.set(String(ws.getRow(1).getCell(c).value), c);
  sites.forEach((code, i) => {
    const row = ws.getRow(i + 2);
    row.getCell(at.get('Site ID')!).value = code;
    for (const c of cols) {
      if (c.kind !== 'task' || c.derived || !at.has(c.header)) continue;
      const cell = row.getCell(at.get(c.header)!);
      if (c.type === 'date') cell.value = new Date(Date.UTC(2026, 1, 1 + (i % 20)));
      else if (c.type === 'number') cell.value = 1;
      else if (c.options?.length) cell.value = c.options[0];
      else cell.value = `Eng ${i}`;
    }
  });
  // a duplicate Site ID (the second row names the same tasks: duplicate_in_file)
  const dup = ws.getRow(sites.length + 2);
  dup.getCell(at.get('Site ID')!).value = sites[1];
  dup.getCell(at.get('CW Survey & Analysis Report / Planned Date')!).value = new Date(Date.UTC(2026, 3, 3));
  const asb = wb.getWorksheet('As-Built')!;
  const ah = new Map<string, number>();
  for (let c = 1; c <= asb.getRow(1).cellCount; c++) ah.set(String(asb.getRow(1).getCell(c).value), c);
  sites.slice(0, 20).forEach((code, i) => {
    asb.getRow(i + 2).getCell(ah.get('Site ID')!).value = code;
    asb.getRow(i + 2).getCell(ah.get('As-Built Date')!).value = new Date(Date.UTC(2026, 4, 1 + i));
  });
  wb.addWorksheet('Scratch').addRow(['not a part of the template']);
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

/** Everything a staged group holds, without ids and times: the batches, then their rows in order. */
async function groupSnapshot(groupId: string): Promise<unknown[]> {
  const batches = await q<Record<string, unknown>>(db, `
    SELECT b.stream_code, b.register_key, b.part_sheet, b.source, b.mode, b.status, b.rows_total, b.rows_error, b.region_scope, b.file_template_version, d.template_id, v.version,
      (SELECT jsonb_agg(jsonb_build_object('sheet', r.sheet, 'row_no', r.row_no, 'site_code', r.site_code, 'task', r.task_code, 'action', r.action, 'decision', r.decision,
          'hold', r.hold_reason, 'key', r.row_key, 'ref', r.source_ref, 'ord', r.ord, 'diff', r.diff, 'errors', r.errors, 'warnings', r.warnings, 'payload', r.payload,
          'record_type', r.record_type) ORDER BY r.ord, r.row_no, r.task_code) FROM import_batch_rows r WHERE r.batch_id = b.id) AS rows
    FROM import_batches b JOIN template_versions v ON v.id = b.template_version_id JOIN template_definitions d ON d.id = v.template_def_id
    WHERE b.group_id = $1 ORDER BY b.part_sheet, b.stream_code NULLS LAST, b.register_key NULLS LAST`, [groupId]);
  return batches;
}

const runOf = async (uploadId: string): Promise<PendingJob> => {
  const j = (await jobs.pending(0)).find((x) => x.job_id === uploadId);
  if (!j) throw new Error('no running upload');
  return j;
};
const get = (who: Actor, id: string) => who.api.call('get', `/import-batches/${id}`);

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_BGUP as string });
  db = new PgClient({ connectionString: process.env.TEST_SUPER_URL_BGUP });
  await db.connect();
  jobs = app.get(ImportJobsService);
  jobs.autoStart = false;
  admin = await plainAdmin(app, db);
  codes = await seed(SITES, `UP${TAG}`);
}, 120_000);
afterAll(async () => {
  jobs.autoStart = true;
  await jobs.idle();
  await setAsyncRows(50);
  await db.end();
  await app.close();
});

describe('a big TPL-MASTER upload is staged in the background', () => {
  it('answers 202 parsing with the progress, refuses the same file while it is parsed, resumes after an interruption, and ends with the same batches as the synchronous upload', async () => {
    const file = await masterFile(admin.api, codes);

    // 1. the same file staged in the request (the threshold above its rows)
    await setAsyncRows(500);
    const sync = await uploadFile(admin.api, file);
    expect(sync.status).toBe(202);
    expect(sync.body.status).toBe('validated');
    expect(sync.body.upload_id).toBeUndefined();
    const syncSnap = await groupSnapshot(sync.body.group_id);
    expect(syncSnap.length).toBeGreaterThanOrEqual(3);                    // CW, TE ... and As-Built
    for (const p of sync.body.parts) {
      const d = await admin.api.call('post', `/import-batches/${p.id}/decisions`, { action: 'discard', scope: 'all' }, { 'If-Match': `"${p.version}"` });
      expect(d.status).toBe(200);
    }

    // 2. in the background (the threshold below its rows)
    await setAsyncRows(10);
    const up = await uploadFile(admin.api, file);
    expect(up.status).toBe(202);
    expect(up.body).toMatchObject({ status: 'parsing', template_id: 'TPL-MASTER', source: 'master_template', counts: { create: 0, error: 0 } });
    expect(up.body.id).toBe(up.body.upload_id);
    expect(up.body.group_id).toBe(up.body.upload_id);
    expect(up.body.progress).toMatchObject({ kind: 'upload', state: 'running', rows_total: SITES + 1 + 20, rows_done: 0, parts_done: 0, percent: 0 });
    expect(up.body.progress.parts_total).toBe(syncSnap.length);
    expect(up.body.warnings.map((w: { code: string }) => w.code)).toContain('unknown_sheet');
    const id = up.body.id as string;
    // nothing is staged yet; the parsed rows are not readable by the application role
    expect(Number((await q<{ n: string }>(db, 'SELECT count(*) AS n FROM import_batches WHERE group_id = $1', [id]))[0]!.n)).toBe(0);

    // the same file again while it is parsed: 409 upload_processing naming the upload
    const again = await uploadFile(admin.api, file);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'upload_processing', upload_id: id });
    // it is listed first, in status parsing; a send waits for the end
    const listed = await admin.api.call('get', '/import-batches?status=parsing');
    expect(listed.body.items.map((x: { id: string }) => x.id)).toContain(id);
    const early = await admin.api.call('post', `/import-batches/${id}/submit`, undefined, { 'If-Match': '"0"' });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('upload_processing');

    // another person sees nothing, cannot continue or stop it
    const other = await plainAdmin(app, db);
    expect((await get(other, id)).status).toBe(404);
    const run = await runOf(id);
    await expect(jobs.step({ ...run, actor_id: other.user.id })).rejects.toThrow(/only the person who uploaded the file/);
    expect((await other.api.call('post', `/import-batches/${id}/decisions`, { action: 'discard', scope: 'all' }, { 'If-Match': '"0"' })).status).toBe(404);

    // one step (a stream part is read 25 rows at a time here), then the process "stops": the progress is committed
    const p1 = await jobs.step(run, 25);
    expect(p1.state).toBe('running');
    const mid = await get(admin, id);
    expect(mid.body.status).toBe('parsing');
    expect(mid.body.progress.rows_done).toBeGreaterThan(0);
    expect(mid.body.progress.rows_done).toBeLessThan(mid.body.progress.rows_total);

    // the resume job takes it after a restart and finishes it
    expect(await jobs.resumeAll(0)).toBe(1);
    const done = await get(admin, id);
    expect(done.status).toBe(200);
    expect(done.body.upload_id).toBe(id);
    expect(done.body.group_id).toBe(id);
    expect(done.body.parts.map((p: { id: string }) => p.id).sort()).toEqual((await q<{ id: string }>(db, 'SELECT id::text FROM import_batches WHERE group_id = $1', [id])).map((x) => x.id).sort());
    expect(done.body.warnings.map((w: { code: string }) => w.code).sort()).toEqual(sync.body.warnings.map((w: { code: string }) => w.code).sort());
    // the same batches, rows, actions, errors, warnings and order as the synchronous upload
    expect(await groupSnapshot(id)).toEqual(syncSnap);
    // the group has its audit row as before; the parsed rows are gone
    expect((await q(db, `SELECT 1 FROM audit_log WHERE action = 'import_master_upload' AND entity_id = $1`, [id])).length).toBe(1);
    const u = (await q<{ state: string; units: unknown; chunks: number }>(db, 'SELECT state, units, chunks FROM import_uploads WHERE id = $1', [id]))[0]!;
    expect(u).toMatchObject({ state: 'done', units: null });
    expect(u.chunks).toBeGreaterThan(syncSnap.length);                   // the stream parts took several transactions
    // and the file can now be uploaded again
    expect(await jobs.resumeAll(0)).toBe(0);
  }, 300_000);

  it('a small upload stays synchronous and unchanged; a stop by the uploader keeps what was staged; rights are checked at the request', async () => {
    await setAsyncRows(10);
    const file = await masterFile(admin.api, codes.slice(0, 20));
    const small = await uploadFile(admin.api, file);         // 20 Master rows + the duplicate row + 20 As-Built rows = 41 > 4 x 10: background
    expect(small.body.status).toBe('parsing');
    // the uploader stops it before it starts: failed (stopped), nothing staged, and the same file can be uploaded again
    const stop = await admin.api.call('post', `/import-batches/${small.body.id}/decisions`, { action: 'discard', scope: 'all' }, { 'If-Match': '"0"' });
    expect(stop.status).toBe(200);
    expect(stop.body).toMatchObject({ status: 'failed', upload: { state: 'failed', error: { code: 'stopped' } } });
    await setAsyncRows(50);
    const sync = await uploadFile(admin.api, file);         // 41 rows, below 4 x 50: staged in the request as before
    expect(sync.status).toBe(202);
    expect(sync.body.status).toBe('validated');
    expect(sync.body.parts.length).toBeGreaterThan(0);

    // without the import right: 403 before anything is read
    const viewer = await actor(app, db, { level: 'entry', regions: [R], modules: null, grants: G('templates', 'view') });
    expect((await uploadFile(viewer.api, file)).status).toBe(403);
    // with the import right but no right on the Site Register nor on the register sheets: refused by the request (as the synchronous upload), nothing recorded
    await setAsyncRows(10);
    const noSites = await actor(app, db, { level: 'entry', regions: [R], modules: null, grants: [...TPL_GRANTS_ENTRY] });
    const refused = await uploadFile(noSites.api, await masterFile(admin.api, codes.slice(0, 20)));
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('template_rejected');
    expect((await q(db, 'SELECT 1 FROM import_uploads WHERE actor_id = $1', [noSites.user.id])).length).toBe(0);
    await setAsyncRows(50);
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------------------------------- the legacy Master preview
interface MasterCol { letter: string; group_top: string | null; group_mid: string | null; name: string | null }

async function legacyFile(sites: string[]): Promise<Buffer> {
  const cols = await q<MasterCol>(db, 'SELECT letter, group_top, group_mid, name FROM master_columns WHERE is_active ORDER BY ord');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Master');
  for (const c of cols) {
    ws.getCell(`${c.letter}1`).value = c.group_top ?? null;
    ws.getCell(`${c.letter}2`).value = c.group_mid ?? null;
    ws.getCell(`${c.letter}3`).value = c.name ?? null;
  }
  [...sites, sites[2]!, 'NOPE-0001'].forEach((code, i) => {
    for (const c of cols) {
      const cell = ws.getCell(`${c.letter}${5 + i}`);
      const nm = `${c.group_mid ?? ''} ${c.name ?? ''}`;
      if (c.name === 'Site ID') cell.value = code;
      else if (/region/i.test(nm)) cell.value = 'GM';
      else if (/date/i.test(nm)) cell.value = new Date(Date.UTC(2026, 1, 1 + (i % 20)));
      else if (c.name === '#') cell.value = i + 1;
      else cell.value = `v${i % 7}`;
    }
  });
  const st = wb.addWorksheet('Setting');
  st.getCell('I1').value = 'Project Staff';
  ['Name', 'Role', 'Region', 'Status'].forEach((h, i) => { st.getCell(2, 9 + i).value = h; });
  st.getCell(3, 9).value = 'Test Person'; st.getCell(3, 10).value = 'Unknown Role'; st.getCell(3, 11).value = 'Nowhere';
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
const uploadLegacy = (api: Api, buf: Buffer) => {
  const t = api.raw('post', '/master-import/runs');
  if (api.csrf) t.set('X-CSRF-Token', api.csrf);
  return t.attach('file', buf, { filename: 'GSDN_Site_Master.xlsx', contentType: 'application/octet-stream' });
};
const runSnapshot = async (runId: string): Promise<unknown> => ({
  run: (await q(db, 'SELECT structure, summary, status FROM master_reconciliation_runs WHERE id = $1', [runId]))[0],
  rows: await q(db, 'SELECT row_no, site_code, site_id, region_id, cells FROM master_reconciliation_rows WHERE run_id = $1 ORDER BY row_no', [runId]),
  diffs: await q(db, `SELECT ord, sheet, row_no, source_ref, site_code, site_id, region_id, master_col, header, field, master_value, pmis_value, kind, reason, applicable
    FROM master_reconciliation_diffs WHERE run_id = $1 ORDER BY ord`, [runId]),
});

describe('a big legacy Master is compared in the background', () => {
  it('answers 202 staging with the progress, refuses the apply until it ends, and ends with the same comparison as in the request', async () => {
    const file = await legacyFile(codes);
    await setAsyncRows(500);
    const sync = await uploadLegacy(admin.api, file);
    expect(sync.status).toBe(201);
    expect(sync.body).toMatchObject({ status: 'previewed', staging: null });
    const want = await runSnapshot(sync.body.id);

    await setAsyncRows(10);
    const up = await uploadLegacy(admin.api, file);
    expect(up.status).toBe(202);
    expect(up.body.status).toBe('staging');
    expect(up.body.staging).toMatchObject({ state: 'running', rows_total: SITES + 2, rows_done: 0, percent: 0 });
    expect((await uploadLegacy(admin.api, file)).body.code).toBe('upload_processing');
    const runId = up.body.id as string;
    const apply = await admin.api.call('post', `/master-import/runs/${runId}/apply`, { mode: 'submit', reason: 'too early' }, { 'If-Match': `"${up.body.version}"` });
    expect(apply.status).toBe(409);
    expect(apply.body.code).toBe('upload_processing');

    const run = await runOf(up.body.staging.upload_id);
    const p1 = await jobs.step(run, 20);
    expect(p1.state).toBe('running');
    const mid = await admin.api.call('get', `/master-import/runs/${runId}`);
    expect(mid.body).toMatchObject({ status: 'staging', staging: { rows_done: 20 } });
    expect(await jobs.resumeAll(0)).toBe(1);
    const done = await admin.api.call('get', `/master-import/runs/${runId}`);
    expect(done.body).toMatchObject({ status: 'previewed', staging: { state: 'done', percent: 100 } });
    // the same structure, summary, rows and differences (ord, reasons, values) as the comparison in the request
    const got = (await runSnapshot(runId)) as { run: Record<string, unknown> };
    expect(got).toEqual(want);
    await setAsyncRows(50);
  }, 300_000);
});
