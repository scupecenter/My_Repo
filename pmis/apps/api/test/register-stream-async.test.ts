import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { randomBytes } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DocumentsService } from '../src/documents/documents.service';
import { ImportJobsService, type PendingJob } from '../src/templates/import-jobs.service';
import { q } from './calc-helpers';
import { Api, delegate, startApp } from './helpers';
import { G, regCell } from './reg-helpers';
import { TPL_GRANTS_ENTRY, day, downloadTemplate, fillTemplate, uploadFile } from './tpl-helpers';
import { SITE_APPROVE_GRANTS, SITE_ENTRY_GRANTS, filled } from './tpl-stream-helpers';
import { Actor, Site, actor, makeSite, makeTask, plainAdmin, setCell } from './wf-helpers';

/**
 * Migration 0075 (technical decision of 2026-11-05 (6), contract 0.14.6): register and stream batches with more rows than imports.async_rows are sent and decided in
 * the background, as New sites batches since 0074, and the threshold is set in Settings, Imports. The suite runs on its own database (TEST_DATABASE_URL_ASYNC, the
 * Document Library active): it changes imports.async_rows, which every other suite reads. Region 6 (GM). The runs are driven by hand (autoStart off): the request is
 * the "first process", step / resumeAll / process are the background.
 */
let app: NestExpressApplication;
let db: PgClient;
let jobs: ImportJobsService;
const R = 6;
const ROWS = 60;
const TAG = randomBytes(2).toString('hex').toUpperCase();
let n = 0;

beforeAll(async () => {
  app = await startApp({ databaseUrl: process.env.TEST_DATABASE_URL_ASYNC as string });
  db = new PgClient({ connectionString: process.env.TEST_SUPER_URL_ASYNC });
  await db.connect();
  jobs = app.get(ImportJobsService);
  jobs.autoStart = false;
}, 120_000);
afterAll(async () => {
  jobs.autoStart = true;
  await jobs.idle();
  await db.end();
  await app.close();
});

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string }>(db, `SELECT count(*) AS n FROM (${sql}) x`, params))[0]!.n);
const runOf = async (batchId: string): Promise<PendingJob> => {
  const j = (await jobs.pending(0)).find((x) => x.batch_id === batchId);
  if (!j) throw new Error('no running job for the batch');
  return j;
};
const send = (who: Actor, id: string, tag: string) => who.api.call('post', `/import-batches/${id}/submit`, undefined, { 'If-Match': tag });
const decide = (who: Actor, id: string, tag: string, body: Record<string, unknown>) => who.api.call('post', `/import-batches/${id}/decisions`, body, { 'If-Match': tag });
const get = (who: Actor, id: string) => who.api.call('get', `/import-batches/${id}`);

// ---------------------------------------------------------------------------------------------------------------------- registers (Issue Log)
const REG_ENTRY: [string, string][] = [...G('issues', 'view', 'create', 'edit'), ...TPL_GRANTS_ENTRY];
const REG_APPROVE: [string, string][] = [...G('issues', 'view', 'approve'), ...G('templates', 'view')];
let issueSite: Site;

/** An Issue Log file of `count` new issues on one site, uploaded by `who`. */
async function issueBatch(who: Actor, rows: number): Promise<{ id: string; tag: string }> {
  issueSite ??= await makeSite(db, R, { prefix: 'ASY' });
  const dl = await downloadTemplate(who.api, 'TPL-ISS');
  const file = await fillTemplate(dl.buffer, Array.from({ length: rows }, () => ({
    'Site ID': issueSite.code, 'Pending Issue': `Async issue ${TAG}-${++n}`, 'Issue Raised Date': day('2026-01-05'), 'Issue Status': 'Open', 'Issue Owner (Aljeel)': who.user.email,
  })));
  const up = await uploadFile(who.api, file);
  expect(up.status).toBe(202);
  expect(up.body.counts).toMatchObject({ create: rows, error: 0 });
  return { id: up.body.id as string, tag: etag(up) };
}
const recordsOf = (batchId: string) => q<{ id: string; state: string; self_approval: boolean; row_no: number }>(db,
  `SELECT r.id, r.state::text AS state, r.self_approval, x.row_no FROM register_records r JOIN import_batch_rows x ON x.id = r.batch_row_id WHERE x.batch_id = $1 ORDER BY x.row_no`, [batchId]);

describe('a big register batch is sent in the background (self-approval, B5)', () => {
  it('answers 202 processing with the progress, needs the step-up at the request, refuses a second send, resumes after an interruption and ends approved', async () => {
    const both = await actor(app, db, { level: 'approve', grants: [...REG_ENTRY, ...G('issues', 'approve')], regions: [R], modules: null });
    const noStep = await actor(app, db, { level: 'approve', grants: [...REG_ENTRY, ...G('issues', 'approve')], regions: [R], modules: null, stepUp: false });
    const other = await actor(app, db, { level: 'approve', grants: REG_APPROVE, regions: [R], modules: null });
    await regCell(db, 'issues', R, 'entry', { user: [both.user.id, noStep.user.id] });
    await regCell(db, 'issues', R, 'approve', { user: [both.user.id, noStep.user.id] });

    // the sender holds L2 too: the step-up is needed now, not later; nothing is queued without it
    const nb = await issueBatch(noStep, ROWS);
    const r401 = await send(noStep, nb.id, nb.tag);
    expect(r401.status).toBe(401);
    expect(r401.body.code).toBe('step_up_required');
    expect((await get(noStep, nb.id)).body).toMatchObject({ status: 'validated', progress: null });

    const b = await issueBatch(both, ROWS);
    expect((await send(other, b.id, b.tag)).status).toBe(403);          // only the uploader sends it
    const sent = await send(both, b.id, b.tag);
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ status: 'processing', progress: { kind: 'submit', batch_kind: 'register', state: 'running', rows_total: ROWS, rows_done: 0, percent: 0 } });
    expect(sent.body.accepted).toBeUndefined();
    expect(await count('SELECT 1 FROM register_records r JOIN import_batch_rows x ON x.id = r.batch_row_id WHERE x.batch_id = $1', [b.id])).toBe(0);   // nothing in the request
    const again = await send(both, b.id, etag(sent));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('batch_processing');

    const run = await runOf(b.id);
    await expect(jobs.step({ ...run, actor_id: other.user.id })).rejects.toThrow(/only the person who asked/);
    const p1 = await jobs.step(run);                                       // one chunk of 50 register rows, then the process "stops"
    expect(p1).toMatchObject({ state: 'running', rows_done: 50, rows_total: ROWS });
    expect((await get(both, b.id)).body).toMatchObject({ status: 'processing', counts: { approved: 50, pending: ROWS - 50 }, progress: { rows_done: 50, percent: 83 } });

    expect(await jobs.resumeAll(0)).toBeGreaterThanOrEqual(1);
    const done = await get(both, b.id);
    expect(done.body).toMatchObject({ status: 'approved', counts: { approved: ROWS, pending: 0 }, progress: { state: 'done', rows_done: ROWS, percent: 100, submitted: ROWS, approved: ROWS, failed: 0 } });
    const recs = await recordsOf(b.id);
    expect(recs).toHaveLength(ROWS);
    expect(recs.every((r) => r.state === 'approved' && r.self_approval)).toBe(true);
    // one audit row per record, by the person, via the batch; the batch: one send row with the totals, the run asked once
    expect(await count(`SELECT 1 FROM audit_log WHERE action = 'register_record_submit' AND batch_id = $1 AND actor_id = $2 AND via = 'template'`, [b.id, both.user.id])).toBe(ROWS);
    const submit = await q<{ after: Record<string, unknown>; actor_id: string }>(db, `SELECT after, actor_id FROM audit_log WHERE action = 'import_batch_submit' AND entity_id = $1`, [b.id]);
    expect(submit).toEqual([expect.objectContaining({ actor_id: both.user.id, after: expect.objectContaining({ submitted: ROWS, held: 0, failed: 0, status: 'approved' }) })]);
    expect(await count(`SELECT 1 FROM audit_log WHERE action = 'import_batch_processing' AND entity_id = $1`, [b.id])).toBe(1);
    expect((await q<{ chunks: number; stepup_verified: boolean }>(db, 'SELECT chunks, stepup_verified FROM import_batch_jobs WHERE batch_id = $1', [b.id]))[0]).toEqual({ chunks: 2, stepup_verified: true });
  }, 240_000);

  it('a small batch (50 rows or fewer) is still sent in the request (200)', async () => {
    const l1 = await actor(app, db, { level: 'entry', grants: REG_ENTRY, regions: [R], modules: null });
    await regCell(db, 'issues', R, 'entry', { user: [l1.user.id] });
    const b = await issueBatch(l1, 3);
    const sent = await send(l1, b.id, b.tag);
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ status: 'in_approval', progress: null, outcome: { submitted: 3, failed: [] } });
  }, 60_000);
});

describe('a big register batch: L1 sends, L2 decides in the background', () => {
  let l1: Actor;
  let l2: Actor;
  beforeAll(async () => {
    l1 = await actor(app, db, { level: 'entry', grants: REG_ENTRY, regions: [R], modules: null });
    l2 = await actor(app, db, { level: 'approve', grants: REG_APPROVE, regions: [R], modules: null });
  });
  const cells = async (approvers: string[] = [l2.user.id]): Promise<void> => {
    await regCell(db, 'issues', R, 'entry', { user: [l1.user.id] });
    await regCell(db, 'issues', R, 'approve', { user: approvers });
  };
  /** A batch of L1, sent in the background and finished: in_approval. */
  async function sentBatch(): Promise<{ id: string; tag: string }> {
    const b = await issueBatch(l1, ROWS);
    const s = await send(l1, b.id, b.tag);
    expect(s.status).toBe(202);
    await jobs.process(await runOf(b.id));
    const w = await get(l2, b.id);
    expect(w.body).toMatchObject({ status: 'in_approval', counts: { pending: ROWS } });
    return { id: b.id, tag: etag(w) };
  }

  it('approve all answers 202; rights, levels and step-up are checked at the request; a row that fails is marked and the others go on', async () => {
    await cells();
    const b = await sentBatch();
    // L1 has no approve right: 403; an L2 without a step-up: 401; an approver of the grid who holds no L2 cell: 403 not_eligible_holder; nothing queued
    expect((await decide(l1, b.id, b.tag, { action: 'approve', scope: 'all' })).status).toBe(403);
    const noStep = await actor(app, db, { level: 'approve', grants: REG_APPROVE, regions: [R], modules: null, stepUp: false });
    await cells([l2.user.id, noStep.user.id]);
    const r401 = await decide(noStep, b.id, b.tag, { action: 'approve', scope: 'all' });
    expect(r401.status).toBe(401);
    expect(r401.body.code).toBe('step_up_required');
    const stranger = await actor(app, db, { level: 'approve', grants: REG_APPROVE, regions: [R], modules: null });
    const r403 = await decide(stranger, b.id, b.tag, { action: 'approve', scope: 'all' });
    expect(r403.status).toBe(403);
    expect(r403.body.code).toBe('not_eligible_holder');
    expect((await get(l2, b.id)).body.status).toBe('in_approval');

    const go = await decide(l2, b.id, b.tag, { action: 'approve', scope: 'all' });
    expect(go.status).toBe(202);
    expect(go.body).toMatchObject({ status: 'processing', progress: { kind: 'decide', action: 'approve', batch_kind: 'register', rows_total: ROWS } });
    const ret = await decide(l2, b.id, etag(go), { action: 'reject', scope: 'all', note: 'no' });
    expect(ret.status).toBe(409);
    expect(ret.body.code).toBe('batch_processing');
    // a record changes after the request (sent back to the review level by another path): its row fails in its chunk, the others are approved
    const victim = (await recordsOf(b.id))[2]!;
    await db.query(`UPDATE register_records SET state = 'in_review' WHERE id = $1`, [victim.id]);
    await jobs.process(await runOf(b.id));
    const done = await get(l2, b.id);
    expect(done.body.progress).toMatchObject({ state: 'done', kind: 'decide', approved: ROWS - 1, failed: 1, rows_done: ROWS });
    const recs = await recordsOf(b.id);
    expect(recs.filter((r) => r.state === 'approved')).toHaveLength(ROWS - 1);
    expect(await count(`SELECT 1 FROM audit_log WHERE action = 'register_record_approve' AND batch_id = $1 AND actor_id = $2`, [b.id, l2.user.id])).toBe(ROWS - 1);
    const approve = await q<{ after: Record<string, unknown> }>(db, `SELECT after FROM audit_log WHERE action = 'import_batch_approve' AND entity_id = $1`, [b.id]);
    expect(approve).toHaveLength(1);
    expect(approve[0]!.after).toMatchObject({ scope: 'all', decided: ROWS - 1, approved: ROWS - 1, failed: 1 });
    const job = await q<{ failed: { code: string; row_no: number }[] }>(db, 'SELECT failed FROM import_batch_jobs WHERE batch_id = $1 AND kind = $2', [b.id, 'decide']);
    expect(job[0]!.failed).toEqual([expect.objectContaining({ code: 'invalid_transition', row_no: victim.row_no })]);
    // the uploader is told once
    expect(await count(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'import_batch' AND link = $2`, [l1.user.id, `/registers/issues/batches/${b.id}`])).toBe(1);
  }, 240_000);

  it('the rights are derived again for every chunk: an approver removed from the L2 cell after the first chunk decides nothing more', async () => {
    await cells();
    const b = await sentBatch();
    expect((await decide(l2, b.id, b.tag, { action: 'approve', scope: 'all' })).status).toBe(202);
    const run = await runOf(b.id);
    expect(await jobs.step(run)).toMatchObject({ state: 'running', rows_done: 50 });
    const other = await actor(app, db, { level: 'approve', grants: REG_APPROVE, regions: [R], modules: null });
    await cells([other.user.id]);
    await jobs.resumeAll(0);
    const done = await get(l2, b.id);
    expect(done.body).toMatchObject({ status: 'partially_approved', progress: { state: 'done', approved: 50, failed: ROWS - 50 } });
    const job = await q<{ failed: { code: string }[] }>(db, `SELECT failed FROM import_batch_jobs WHERE batch_id = $1 AND kind = 'decide'`, [b.id]);
    expect(new Set(job[0]!.failed.map((f) => f.code))).toEqual(new Set(['not_eligible_holder']));
  }, 240_000);

  it('a return of every row with one note runs in the background too and ends rejected (the records go back to L1)', async () => {
    await cells();
    const b = await sentBatch();
    expect((await decide(l2, b.id, b.tag, { action: 'reject', scope: 'all' })).status).toBe(422);          // a return needs a note
    const go = await decide(l2, b.id, b.tag, { action: 'reject', scope: 'all', note: 'Wrong owner on every row' });
    expect(go.status).toBe(202);
    expect(go.body.progress).toMatchObject({ kind: 'decide', action: 'reject', rows_total: ROWS });
    await jobs.process(await runOf(b.id));
    const done = await get(l2, b.id);
    expect(done.body).toMatchObject({ status: 'rejected', note: 'Wrong owner on every row', counts: { rejected: ROWS }, progress: { state: 'done', rejected: ROWS, failed: 0 } });
    expect((await recordsOf(b.id)).every((r) => r.state === 'entry')).toBe(true);
    expect(await count(`SELECT 1 FROM audit_log WHERE action = 'import_batch_reject' AND entity_id = $1`, [b.id])).toBe(1);
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------------------------------- streams (TPL-SITE-CW)
/** `rows` sites of region 6 with the task `code` open. */
async function sitesWith(code: string, rows: number): Promise<{ site: Site; task: string }[]> {
  const out: { site: Site; task: string }[] = [];
  for (let i = 0; i < rows; i++) {
    const site = await makeSite(db, R, { prefix: 'ASS' });
    out.push({ site, task: await makeTask(db, site, code, 'open') });
  }
  return out;
}
const taskStates = (ids: string[]) => q<{ id: string; state: string; self_approval: boolean; f: boolean }>(db,
  'SELECT id::text AS id, state::text AS state, self_approval, historical_no_documents AS f FROM task_instances WHERE id = ANY($1::uuid[])', [ids]);

describe('a big stream batch in the background', () => {
  it('a self-approved send: 202, the documents of each chunk are synchronised in that chunk (never in the request), every task approved', async () => {
    const both = await actor(app, db, { level: 'approve', grants: [...SITE_ENTRY_GRANTS, ...G('sites', 'approve'), ...G('approvals', 'view', 'approve')], regions: [R], modules: null });
    await setCell(db, 'B4', R, 'entry', { user: [both.user.id] });
    await setCell(db, 'B4', R, 'approve', { user: [both.user.id] });
    const sites = await sitesWith('B4', ROWS);
    const up = await uploadFile(both.api, await filled(both.api, 'TPL-SITE-CW', sites.map((s) => ({ 'Site ID': s.site.code, 'B4 CW Survey Actual': day('2026-01-10') }))));
    expect(up.status).toBe(202);
    expect(up.body.counts).toMatchObject({ update: ROWS, error: 0 });
    const docs = app.get(DocumentsService);
    const spy = vi.spyOn(docs, 'syncTaskById');
    try {
      const sent = await send(both, up.body.id, etag(up));
      expect(sent.status).toBe(202);
      expect(sent.body).toMatchObject({ status: 'processing', progress: { kind: 'submit', batch_kind: 'stream', rows_total: ROWS } });
      expect(spy).not.toHaveBeenCalled();                                   // the request synchronises nothing
      const run = await runOf(up.body.id);
      expect(await jobs.step(run)).toMatchObject({ state: 'running', rows_done: 25 });
      expect(spy).toHaveBeenCalledTimes(25);
      const first = new Set(spy.mock.calls.map((c) => c[0]));
      const rowsTasks = (await q<{ t: string }>(db, 'SELECT task_instance_id::text AS t FROM import_batch_rows WHERE batch_id = $1 ORDER BY ord LIMIT 25', [up.body.id])).map((r) => r.t);
      expect(first).toEqual(new Set(rowsTasks));                           // exactly the tasks of that chunk
      await jobs.resumeAll(0);
      expect(spy).toHaveBeenCalledTimes(ROWS);
    } finally {
      spy.mockRestore();
    }
    const done = await get(both, up.body.id);
    expect(done.body).toMatchObject({ status: 'approved', counts: { approved: ROWS }, progress: { state: 'done', submitted: ROWS, approved: ROWS, failed: 0 } });
    const t = await taskStates(sites.map((s) => s.task));
    expect(t.every((x) => x.state === 'approved' && x.self_approval)).toBe(true);
    expect(await count(`SELECT 1 FROM audit_log WHERE action = 'task_submit' AND batch_id = $1 AND via = 'template' AND actor_id = $2`, [up.body.id, both.user.id])).toBe(ROWS);
    expect(await count(`SELECT 1 FROM audit_log WHERE action = 'import_batch_submit' AND entity_id = $1`, [up.body.id])).toBe(1);
  }, 300_000);

  it('L1 sends, L2 approves all in the background; the tasks are approved by L2', async () => {
    const l1 = await actor(app, db, { level: 'entry', grants: SITE_ENTRY_GRANTS, regions: [R], modules: null });
    const l2 = await actor(app, db, { level: 'approve', grants: SITE_APPROVE_GRANTS, regions: [R], modules: null });
    await setCell(db, 'B4', R, 'entry', { user: [l1.user.id] });
    await setCell(db, 'B4', R, 'approve', { user: [l2.user.id] });
    const sites = await sitesWith('B4', ROWS);
    const up = await uploadFile(l1.api, await filled(l1.api, 'TPL-SITE-CW', sites.map((s) => ({ 'Site ID': s.site.code, 'B4 CW Survey Actual': day('2026-01-11') }))));
    expect((await send(l1, up.body.id, etag(up))).status).toBe(202);
    await jobs.process(await runOf(up.body.id));
    const w = await get(l2, up.body.id);
    expect(w.body).toMatchObject({ status: 'in_approval', counts: { pending: ROWS } });
    expect((await taskStates(sites.map((s) => s.task))).every((x) => x.state === 'in_approval')).toBe(true);
    const go = await decide(l2, up.body.id, etag(w), { action: 'approve', scope: 'all' });
    expect(go.status).toBe(202);
    await jobs.process(await runOf(up.body.id));
    const done = await get(l2, up.body.id);
    expect(done.body).toMatchObject({ status: 'approved', progress: { state: 'done', kind: 'decide', approved: ROWS } });
    expect((await taskStates(sites.map((s) => s.task))).every((x) => x.state === 'approved' && !x.self_approval)).toBe(true);
    expect(await count(`SELECT 1 FROM workflow_steps s JOIN task_instances t ON t.id = s.task_id WHERE t.id = ANY($1::uuid[]) AND s.action = 'approve' AND s.acted_by = $2`,
      [sites.map((s) => s.task), l2.user.id])).toBe(ROWS);
  }, 300_000);

  it('a batch marked "historical load" is still checked row by row in each chunk: rows sent after the waiver closed need their documents again', async () => {
    const admin = await plainAdmin(app, db);
    const approver = await actor(app, db, { level: 'approve', grants: SITE_APPROVE_GRANTS, regions: [R], modules: null });
    await setCell(db, 'B6', R, 'entry', { user: [admin.user.id] });
    await setCell(db, 'B6', R, 'approve', { user: [approver.user.id] });
    const sites = await sitesWith('B6', ROWS);
    expect((await admin.api.call('put', '/settings/historical-waiver', { open: true, cutoff_date: '2026-01-31', reason: 'Open for the async load test' })).status).toBe(200);
    try {
      const up = await uploadFile(admin.api, await filled(admin.api, 'TPL-SITE-CW', sites.map((s) => ({ 'Site ID': s.site.code, 'B6 Actual Date': day('2026-01-10') }))),
        'filled.xlsx', { historical_load_reason: 'One-time load of the historical tasks' });
      expect(up.status).toBe(202);
      expect(up.body.historical_load).toMatchObject({ cutoff_date: '2026-01-31' });
      const sent = await send(admin, up.body.id, etag(up));
      expect(sent.status).toBe(202);
      expect(await jobs.step(await runOf(up.body.id))).toMatchObject({ rows_done: 25 });
      // the waiver closes between two chunks: the mark of the batch no longer covers the rows that are still to send
      expect((await admin.api.call('put', '/settings/historical-waiver', { open: false, reason: 'Closed in the middle of the load' })).status).toBe(200);
      await jobs.resumeAll(0);
      const done = await get(admin, up.body.id);
      expect(done.body.progress).toMatchObject({ state: 'done', submitted: 25, failed: ROWS - 25 });
      const t = await taskStates(sites.map((s) => s.task));
      expect(t.filter((x) => x.f && x.state === 'in_approval')).toHaveLength(25);
      expect(t.filter((x) => x.state === 'open' || x.state === 'entry')).toHaveLength(ROWS - 25);
      const errs = await q<{ code: string }>(db, `SELECT errors -> 0 ->> 'code' AS code FROM import_batch_rows WHERE batch_id = $1 AND action = 'error'`, [up.body.id]);
      expect(errs).toHaveLength(ROWS - 25);
      expect(new Set(errs.map((e) => e.code))).toEqual(new Set(['mandatory_slots_missing']));
      expect(await count(`SELECT 1 FROM audit_log WHERE action = 'task_historical_no_documents' AND batch_id = $1`, [up.body.id])).toBe(25);
    } finally {
      await db.query(`UPDATE settings SET value = '{"open": false, "cutoff_date": null}'::jsonb WHERE key = 'load.historical_waiver'`);
    }
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------------------------------- Settings, Imports
describe('Settings, Imports: the background threshold imports.async_rows', () => {
  let admin: Actor;
  let plain: Actor;
  let allDelegate: Actor;
  let regDelegate: Actor;
  beforeAll(async () => {
    admin = await plainAdmin(app, db, false);         // no step-up: the change does not need one (the rule of the calendar confirmation)
    plain = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
    allDelegate = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
    await delegate(db, allDelegate.user.id, [['settings', 'edit']]);
    regDelegate = await actor(app, db, { level: 'view', grants: G('sites', 'view'), regions: [5], modules: null });
    await delegate(db, regDelegate.user.id, [['settings', 'edit']], [5]);
  });
  const read = (who: Actor) => who.api.call('get', '/settings/imports');
  const put = (who: Actor, body: unknown, tag?: string) => who.api.call('put', '/settings/imports', body, tag === undefined ? {} : { 'If-Match': tag });
  const value = async (): Promise<unknown> => (await q<{ value: unknown }>(db, `SELECT value FROM settings WHERE key = 'imports.async_rows'`))[0]?.value;
  const audits = () => q<{ before: any; after: any; reason: string; actor_id: string }>(db,
    `SELECT before, after, reason, actor_id::text AS actor_id FROM audit_log WHERE action = 'imports_async_rows_update' AND entity_id = 'imports.async_rows' ORDER BY id`);

  it('every signed-in user reads it (default 50, range 10 to 500); only a System Admin or an all-regions delegate of settings may edit', async () => {
    for (const [who, can] of [[plain, false], [regDelegate, false], [allDelegate, true], [admin, true]] as [Actor, boolean][]) {
      const r = await read(who);
      expect(r.status).toBe(200);
      expect(etag(r)).toMatch(/^"\d{1,9}"$/);
      expect(r.body).toMatchObject({ async_rows: 50, default_async_rows: 50, min: 10, max: 500, updated_by: null, can_edit: can });
    }
    expect((await new Api(app).raw('get', '/settings/imports')).status).toBe(401);
    const tag = etag(await read(admin));
    for (const who of [plain, regDelegate]) {
      const r = await put(who, { async_rows: 20, reason: 'I want it' }, tag);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('action_forbidden');
    }
    expect(await value()).toBe(50);
    expect(await audits()).toHaveLength(0);
  });

  it('validates the value, the reason, unknown keys and If-Match; a change is audited with before and after; the same value again is 409', async () => {
    const cur = await read(admin);
    expect((await put(admin, { async_rows: 20, reason: 'no tag' })).status).toBe(428);
    const stale = await put(admin, { async_rows: 20, reason: 'stale tag' }, '"1"');
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('precondition_failed');
    for (const bad of [{ async_rows: 20 }, { async_rows: 20, reason: 'ab' }, { async_rows: 9, reason: 'too small' }, { async_rows: 501, reason: 'too big' },
      { async_rows: 25.5, reason: 'not whole' }, { async_rows: '30', reason: 'text' }, { async_rows: 30, reason: 'extra', mode: 'fast' }]) {
      const r = await put(admin, bad, etag(cur));
      expect(r.status).toBe(422);
    }
    const range = await put(admin, { async_rows: 501, reason: 'too big' }, etag(cur));
    expect(range.body.errors[0]).toMatchObject({ path: '/async_rows' });
    const extra = await put(admin, { async_rows: 30, reason: 'extra', mode: 'fast' }, etag(cur));
    expect(extra.body.errors[0]).toMatchObject({ code: 'unknown_field' });
    expect(await value()).toBe(50);

    const ok = await put(admin, { async_rows: 20, reason: 'Smaller batches go to the background' }, etag(cur));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ async_rows: 20, updated_by: { id: admin.user.id } });
    expect(ok.body.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(etag(ok)).not.toBe(etag(cur));
    expect(await value()).toBe(20);
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_id: admin.user.id, reason: 'Smaller batches go to the background', before: { async_rows: 50 }, after: { async_rows: 20, updated_by: admin.user.id } });
    const same = await put(admin, { async_rows: 20, reason: 'twice' }, etag(ok));
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('invalid_transition');
  });

  it('the next send uses the new value: 30 rows go to the background at 20, and stay in the request at 50 (set back by an all-regions delegate)', async () => {
    const l1 = await actor(app, db, { level: 'entry', grants: REG_ENTRY, regions: [R], modules: null });
    await regCell(db, 'issues', R, 'entry', { user: [l1.user.id] });
    expect((await read(l1)).body.async_rows).toBe(20);
    const b = await issueBatch(l1, 30);
    const sent = await send(l1, b.id, b.tag);
    expect(sent.status).toBe(202);
    await jobs.process(await runOf(b.id));
    expect((await get(l1, b.id)).body.status).toBe('in_approval');

    const back = await put(allDelegate, { async_rows: 50, reason: 'Back to the default on behalf of the administrator' }, etag(await read(allDelegate)));
    expect(back.status).toBe(200);
    expect((await audits()).at(-1)).toMatchObject({ actor_id: allDelegate.user.id, before: { async_rows: 20 }, after: { async_rows: 50 } });
    const b2 = await issueBatch(l1, 30);
    const sent2 = await send(l1, b2.id, b2.tag);
    expect(sent2.status).toBe(200);
    expect(sent2.body.outcome).toMatchObject({ submitted: 30 });
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------------------------------- the Master import apply
/** A legacy Master workbook (three header rows, a SUBTOTAL row, data from row 5) with the B4 CW Survey Actual (AO) of each site. */
async function masterFile(codes: string[]): Promise<Buffer> {
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
  codes.forEach((code, i) => {
    ws.getCell(`A${5 + i}`).value = i + 1;
    ws.getCell(`B${5 + i}`).value = code;
    const d = ws.getCell(`AO${5 + i}`);
    d.value = day('2026-02-03');
    d.numFmt = 'yyyy-mm-dd';
  });
  const st = wb.addWorksheet('Setting');
  st.getCell('I1').value = 'Project Staff';
  ['Name', 'Role', 'Region', 'Status'].forEach((h, i) => { st.getCell(2, 9 + i).value = h; });
  for (const s of ['RF & Design', 'Acquisition']) wb.addWorksheet(s);
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
const uploadMaster = async (api: Api, buf: Buffer): Promise<Record<string, any>> => {
  const t = api.raw('post', '/master-import/runs');
  if (api.csrf) t.set('X-CSRF-Token', api.csrf);
  const r = await t.attach('file', buf, { filename: 'GSDN_Site_Master.xlsx', contentType: 'application/octet-stream' });
  expect(r.status).toBe(201);
  return r.body as Record<string, any>;
};

describe('the Master import apply sends a big staged batch in the background', () => {
  it('answers 202 with the run applied and the progress of its batch; the rows are sent in chunks by the same admin; a small apply stays 200', async () => {
    const MR = 3;   // no matrix cell of B4 in region 3 on this database: the System Admin is the holder of last resort, as in master-import.test.ts
    const admin = await plainAdmin(app, db);
    const tasks: string[] = [];
    const codes: string[] = [];
    for (let i = 0; i < ROWS; i++) {
      const site = await makeSite(db, MR, { prefix: 'ASM' });
      tasks.push(await makeTask(db, site, 'B4', 'open'));
      codes.push(site.code);
    }
    const run = await uploadMaster(admin.api, await masterFile(codes));
    const docs = app.get(DocumentsService);
    const spy = vi.spyOn(docs, 'syncTaskById');
    try {
      const ok = await admin.api.call('post', `/master-import/runs/${run.id}/apply`, { mode: 'submit', reason: 'Initial load in the background' }, { 'If-Match': `"${run.version}"` });
      expect(ok.status).toBe(202);
      expect(ok.body).toMatchObject({ status: 'applied', progress: { state: 'running', batches: 1, rows_total: ROWS, rows_done: 0 } });
      expect(ok.body.accepted).toBeUndefined();
      const b = ok.body.outcome.batches[0];
      expect(b).toMatchObject({ queued: true, rows: ROWS, submitted: 0, ref: 'CW' });
      expect((await taskStates(tasks)).every((t) => t.state === 'open')).toBe(true);           // nothing sent in the request
      await jobs.process(await runOf(b.id));
      expect(spy).not.toHaveBeenCalled();                                                     // as before: the apply never synchronised the documents
    } finally {
      spy.mockRestore();
    }
    const after = await admin.api.call('get', `/master-import/runs/${run.id}`);
    expect(after.body.progress).toMatchObject({ state: 'done', rows_done: ROWS, percent: 100, submitted: ROWS, failed: 0 });
    expect((await taskStates(tasks)).every((t) => ['in_review', 'in_approval'].includes(t.state))).toBe(true);
    expect(await count(`SELECT 1 FROM audit_log WHERE action = 'master_import.apply' AND entity_id = $1`, [run.id])).toBe(1);

    // a small Master: sent in the request, no progress
    const s = await makeSite(db, MR, { prefix: 'ASM' });
    await makeTask(db, s, 'B4', 'open');
    const small = await uploadMaster(admin.api, await masterFile([s.code]));
    const r = await admin.api.call('post', `/master-import/runs/${small.id}/apply`, { mode: 'submit', reason: 'Small load' }, { 'If-Match': `"${small.version}"` });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'applied', progress: null });
    expect(r.body.outcome.batches[0]).toMatchObject({ submitted: 1 });
  }, 300_000);
});
