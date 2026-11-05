import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImportJobsService, type PendingJob } from '../src/templates/import-jobs.service';
import { q } from './calc-helpers';
import { startApp, superDb } from './helpers';
import { downloadTemplate, fillTemplate, uploadFile } from './tpl-helpers';
import { Actor, actor } from './wf-helpers';

/**
 * Migration 0074 (technical decision of 2026-11-05): a New sites batch with more rows than imports.async_rows (50) is sent or approved in the background,
 * in chunks of 25 rows, each chunk its own transaction under a newly signed context of the same person. The request answers 202 with the status
 * `processing` and the progress; a second send or decision is refused (409 batch_processing); the resume job finishes a run left behind.
 * Region 5 (Benghazi) is the working region: no other suite sets cells of the Matrix row `site_creation` there. Every Site ID is new (a random prefix).
 * The runs are driven by hand here (autoStart off): the request is the "first process", resumeAll / step are the background.
 */
let app: NestExpressApplication;
let db: PgClient;
let jobs: ImportJobsService;
const R = 5;
const ROWS = 60;
const TAG = randomBytes(2).toString('hex').toUpperCase();
let n = 0;
const code = (): string => `SA${TAG}${String(++n).padStart(4, '0')}`;

const L1_GRANTS: [string, string][] = [['sites', 'view'], ['sites', 'create'], ['templates', 'view'], ['templates', 'import'], ['templates', 'download_documents']];
const L2_GRANTS: [string, string][] = [['sites', 'view'], ['sites', 'approve'], ['templates', 'view']];
let l1: Actor;
let l2: Actor;
let both: Actor;

async function siteCell(region: number, kind: 'entry' | 'approve', users: string[]): Promise<void> {
  const level = kind === 'entry' ? 1 : 3;
  await db.query('DELETE FROM matrix_cells WHERE register_key = $1 AND level = $2 AND region_id = $3', ['site_creation', level, region]);
  const c = await db.query(`INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ('site_creation', $1, 'any_one', $2, false, now()) RETURNING id`, [level, region]);
  for (const u of users) await db.query(`INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, 'user', $2)`, [c.rows[0].id, u]);
}

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  jobs = app.get(ImportJobsService);
  jobs.autoStart = false;
  l1 = await actor(app, db, { level: 'entry', regions: [R], grants: L1_GRANTS });
  l2 = await actor(app, db, { level: 'approve', regions: [R], grants: L2_GRANTS });
  both = await actor(app, db, { level: 'approve', regions: [R], grants: [...L1_GRANTS, ['sites', 'approve']] });
  await siteCell(R, 'entry', [l1.user.id, both.user.id]);
  await siteCell(R, 'approve', [l2.user.id, both.user.id]);
}, 120_000);
afterAll(async () => {
  jobs.autoStart = true;
  await jobs.idle();
  await db.end();
  await app.close();
});

const etag = (res: { headers: Record<string, unknown> }): string => String(res.headers.etag);

/** A file of `count` valid rows (New Build, Hot Swap and Expansion mixed) uploaded by `who`. Returns the batch and the Site IDs. */
async function bigBatch(who: Actor, count: number): Promise<{ id: string; tag: string; codes: string[] }> {
  const codes = Array.from({ length: count }, () => code());
  const file = await fillTemplate((await downloadTemplate(who.api, 'TPL-SITE-NEW')).buffer, codes.map((c, i) => ({
    'Site ID': c, Region: 'Benghazi', 'Site Name (EN)': `Async ${i + 1}`, 'Delivery Scenario': i % 5 === 0 ? 'Hot Swap' : i % 7 === 0 ? 'Expansion' : 'New Build',
  })));
  const up = await uploadFile(who.api, file);
  expect(up.status).toBe(202);
  expect(up.body.counts.create).toBe(count);
  return { id: up.body.id as string, tag: etag(up), codes };
}
const runOf = async (batchId: string): Promise<PendingJob> => {
  const all = await jobs.pending(0);
  const j = all.find((x) => x.batch_id === batchId);
  if (!j) throw new Error('no running job for the batch');
  return j;
};
const sitesOf = async (codes: string[]): Promise<{ id: string; site_code: string }[]> =>
  q(db, 'SELECT id, site_code FROM sites WHERE site_code = ANY($1::text[])', [codes]);
const auditCount = async (action: string, entity: string): Promise<number> =>
  Number((await q<{ n: string }>(db, 'SELECT count(*) AS n FROM audit_log WHERE action = $1 AND entity_id = $2', [action, entity]))[0]!.n);

describe('a big New sites batch is sent in the background (self-approval, B5)', () => {
  it('answers 202 processing with the progress, refuses a second send, shows the progress chunk by chunk, resumes after an interruption, ends approved', async () => {
    const b = await bigBatch(both, ROWS);

    // a step-up is needed now (self-approval), not later: without it nothing is queued
    const noStep = await actor(app, db, { level: 'approve', regions: [R], grants: [...L1_GRANTS, ['sites', 'approve']], stepUp: false });
    await siteCell(R, 'entry', [l1.user.id, both.user.id, noStep.user.id]);
    await siteCell(R, 'approve', [l2.user.id, both.user.id, noStep.user.id]);
    const nb = await bigBatch(noStep, ROWS);
    const refused = await noStep.api.call('post', `/import-batches/${nb.id}/submit`, undefined, { 'If-Match': nb.tag });
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('step_up_required');
    expect((await noStep.api.call('get', `/import-batches/${nb.id}`)).body.status).toBe('validated');
    // only the uploader sends it
    expect((await l2.api.call('post', `/import-batches/${b.id}/submit`, undefined, { 'If-Match': b.tag })).status).toBe(403);

    const sent = await both.api.call('post', `/import-batches/${b.id}/submit`, undefined, { 'If-Match': b.tag });
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ status: 'processing', progress: { kind: 'submit', state: 'running', rows_total: ROWS, rows_done: 0, percent: 0 } });
    expect(sent.body.accepted).toBeUndefined();
    expect(sent.body.version).toBeGreaterThan(Number(b.tag.replace(/"/g, '')));
    // a second send, a discard or a decision while it runs: 409 batch_processing (the old If-Match is stale anyway, so use the new one)
    const again = await both.api.call('post', `/import-batches/${b.id}/submit`, undefined, { 'If-Match': etag(sent) });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('batch_processing');
    const disc = await both.api.call('post', `/import-batches/${b.id}/decisions`, { action: 'discard', scope: 'all' }, { 'If-Match': etag(sent) });
    expect(disc.status).toBe(409);
    expect(disc.body.code).toBe('batch_processing');
    // the list shows it with the status processing
    const listed = await both.api.call('get', '/import-batches?status=processing&limit=100');
    expect(listed.body.items.map((x: { id: string }) => x.id)).toContain(b.id);

    // somebody else cannot continue the run under their own name
    const run = await runOf(b.id);
    await expect(jobs.step({ ...run, actor_id: l2.user.id })).rejects.toThrow(/only the person who asked/);

    // one chunk, then the process "stops" (the run stays processing, the rows done so far are committed and visible)
    const p1 = await jobs.step(run);
    expect(p1).toMatchObject({ state: 'running', rows_done: 25, rows_total: ROWS });
    const mid = await both.api.call('get', `/import-batches/${b.id}`);
    expect(mid.body).toMatchObject({ status: 'processing', counts: { approved: 25, pending: ROWS - 25 }, progress: { rows_done: 25, percent: 41 } });
    expect(await sitesOf(b.codes)).toHaveLength(25);

    // the resume job (after an API restart) finishes it
    expect(await jobs.resumeAll(0)).toBeGreaterThanOrEqual(1);
    const done = await both.api.call('get', `/import-batches/${b.id}`);
    expect(done.body).toMatchObject({ status: 'approved', counts: { approved: ROWS, pending: 0 }, progress: { state: 'done', rows_done: ROWS, percent: 100, submitted: ROWS, failed: 0 } });
    const sites = await sitesOf(b.codes);
    expect(sites).toHaveLength(ROWS);
    // the audit: one site_create per site, flagged as a self-approval, by the person, one send row with the totals, the run asked once
    const created = await q<{ n: string }>(db, `SELECT count(*) AS n FROM audit_log WHERE action = 'site_create' AND entity_id = ANY($1::text[]) AND actor_id = $2
      AND (after ->> 'self_approval')::boolean AND after ->> 'batch_id' = $3`, [sites.map((s) => s.id), both.user.id, b.id]);
    expect(Number(created[0]!.n)).toBe(ROWS);
    const submit = await q<{ after: Record<string, unknown>; actor_id: string }>(db, `SELECT after, actor_id FROM audit_log WHERE action = 'import_batch_submit' AND entity_id = $1`, [b.id]);
    expect(submit).toHaveLength(1);
    expect(submit[0]).toMatchObject({ actor_id: both.user.id, after: { submitted: ROWS, failed: 0, status: 'approved' } });
    expect(await auditCount('import_batch_processing', b.id)).toBe(1);
    // every N/A of the scenario is audited, once per task
    const na = await q<{ n: string }>(db, `SELECT count(*) AS n FROM audit_log a JOIN task_instances ti ON ti.id::text = a.entity_id WHERE a.action = 'task_applicability_na' AND ti.site_id = ANY($1::uuid[])`, [sites.map((s) => s.id)]);
    const naTasks = await q<{ n: string }>(db, `SELECT count(*) AS n FROM task_instances WHERE site_id = ANY($1::uuid[]) AND state = 'na'`, [sites.map((s) => s.id)]);
    expect(Number(na[0]!.n)).toBe(Number(naTasks[0]!.n));
    // the run kept the step-up verified at the request; the drafts carry the self-approval
    const job = await q<{ stepup_verified: boolean; state: string; chunks: number }>(db, 'SELECT stepup_verified, state, chunks FROM import_batch_jobs WHERE batch_id = $1', [b.id]);
    expect(job[0]).toMatchObject({ stepup_verified: true, state: 'done', chunks: 3 });
    const drafts = await q<{ n: string }>(db, `SELECT count(*) AS n FROM site_drafts WHERE batch_id = $1 AND status = 'approved' AND self_approval`, [b.id]);
    expect(Number(drafts[0]!.n)).toBe(ROWS);
    // the job run of the resume is recorded
    expect(Number((await q<{ n: string }>(db, `SELECT count(*) AS n FROM job_runs WHERE name = 'import_batch_resume'`))[0]!.n)).toBeGreaterThan(0);
    // after the end, a new send of the closed batch is the ordinary refusal
    const late = await both.api.call('post', `/import-batches/${b.id}/submit`, undefined, { 'If-Match': etag(done) });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('invalid_transition');
  }, 180_000);

  it('a row that fails is marked with its error and the others go on; the batch ends partially approved', async () => {
    const b = await bigBatch(both, ROWS);
    // a site with the Site ID of row 3 appears after the upload (another path), so that row fails when it is sent
    const victim = b.codes[2]!;
    await db.query(`INSERT INTO site_drafts (site_code, region_id, data, status, created_by) VALUES ($1, $2, $3, 'in_approval', $4)`,
      [victim, R, JSON.stringify({ site_code: victim, region_id: R, name: 'Taken', delivery_scenario: 'new_build' }), l1.user.id]);
    const sent = await both.api.call('post', `/import-batches/${b.id}/submit`, undefined, { 'If-Match': b.tag });
    expect(sent.status).toBe(202);
    await jobs.process(await runOf(b.id));
    const done = await both.api.call('get', `/import-batches/${b.id}`);
    expect(done.body.progress).toMatchObject({ state: 'done', submitted: ROWS - 1, failed: 1 });
    expect(done.body.counts).toMatchObject({ approved: ROWS - 1, error: 1 });
    const rows = (await both.api.call('get', `/import-batches/${b.id}/rows?action=error`)).body.items as { key: string; errors: { code: string }[] }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe(victim);
    expect(rows[0]!.errors[0]!.code).toBeTruthy();
    expect(await sitesOf(b.codes)).toHaveLength(ROWS - 1);
  }, 180_000);
});

describe('a big New sites batch: L1 sends (drafts), L2 approves all in the background', () => {
  it('the send of drafts runs in the background too; L2 approval answers 202; rights and step-up are checked at the request; sites created with the L1 as creator', async () => {
    const b = await bigBatch(l1, ROWS);
    const sent = await l1.api.call('post', `/import-batches/${b.id}/submit`, undefined, { 'If-Match': b.tag });
    expect(sent.status).toBe(202);
    await jobs.process(await runOf(b.id));
    const waiting = await l2.api.call('get', `/import-batches/${b.id}`);
    expect(waiting.body).toMatchObject({ status: 'in_approval', counts: { pending: ROWS, approved: 0 } });
    expect(await sitesOf(b.codes)).toHaveLength(0);

    // L1 cannot approve (no approve right on sites: 403); an L2 without a step-up: 401 and nothing queued
    expect((await l1.api.call('post', `/import-batches/${b.id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': etag(waiting) })).status).toBe(403);
    const noStep = await actor(app, db, { level: 'approve', regions: [R], grants: L2_GRANTS, stepUp: false });
    await siteCell(R, 'approve', [l2.user.id, both.user.id, noStep.user.id]);
    const r401 = await noStep.api.call('post', `/import-batches/${b.id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': etag(waiting) });
    expect(r401.status).toBe(401);
    expect(r401.body.code).toBe('step_up_required');
    // an approve holder of the grid who is not an L2 holder of the row: 403, nothing queued
    const notHolder = await actor(app, db, { level: 'approve', regions: [R], grants: L2_GRANTS });
    const r403 = await notHolder.api.call('post', `/import-batches/${b.id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': etag(waiting) });
    expect(r403.status).toBe(403);
    expect(r403.body.code).toBe('not_eligible_holder');
    expect((await l2.api.call('get', `/import-batches/${b.id}`)).body.status).toBe('in_approval');

    const go = await l2.api.call('post', `/import-batches/${b.id}/decisions`, { action: 'approve', scope: 'all' }, { 'If-Match': etag(waiting) });
    expect(go.status).toBe(202);
    expect(go.body).toMatchObject({ status: 'processing', progress: { kind: 'decide', rows_total: ROWS } });
    // a return while it runs: 409
    const ret = await l2.api.call('post', `/import-batches/${b.id}/decisions`, { action: 'reject', scope: 'all', note: 'no' }, { 'If-Match': etag(go) });
    expect(ret.status).toBe(409);
    expect(ret.body.code).toBe('batch_processing');
    await jobs.process(await runOf(b.id));
    const done = await l2.api.call('get', `/import-batches/${b.id}`);
    expect(done.body).toMatchObject({ status: 'approved', counts: { approved: ROWS, pending: 0 }, progress: { state: 'done', approved: ROWS } });
    const sites = await sitesOf(b.codes);
    expect(sites).toHaveLength(ROWS);
    const created = await q<{ n: string }>(db, `SELECT count(*) AS n FROM audit_log WHERE action = 'site_create' AND entity_id = ANY($1::text[]) AND actor_id = $2
      AND NOT (after ->> 'self_approval')::boolean AND after ->> 'created_by' = $3`, [sites.map((s) => s.id), l2.user.id, l1.user.id]);
    expect(Number(created[0]!.n)).toBe(ROWS);
    const approve = await q<{ after: Record<string, unknown> }>(db, `SELECT after FROM audit_log WHERE action = 'import_batch_approve' AND entity_id = $1`, [b.id]);
    expect(approve).toHaveLength(1);
    expect(approve[0]!.after).toMatchObject({ scope: 'all', decided: ROWS, approved: ROWS, status: 'approved' });
    // the uploader is told once
    const told = await q<{ n: string }>(db, `SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND kind = 'import_batch' AND link = $2`, [l1.user.id, `/templates/batches/${b.id}`]);
    expect(Number(told[0]!.n)).toBe(1);
  }, 240_000);

  it('a run whose person was deactivated is stopped by the resume job; the rows done stay, the rest stays pending', async () => {
    const who = await actor(app, db, { level: 'approve', regions: [R], grants: [...L1_GRANTS, ['sites', 'approve']] });
    await siteCell(R, 'entry', [l1.user.id, both.user.id, who.user.id]);
    await siteCell(R, 'approve', [l2.user.id, both.user.id, who.user.id]);
    const b = await bigBatch(who, ROWS);
    expect((await who.api.call('post', `/import-batches/${b.id}/submit`, undefined, { 'If-Match': b.tag })).status).toBe(202);
    await jobs.step(await runOf(b.id));
    await db.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [who.user.id]);
    await jobs.resumeAll(0);
    const job = await q<{ state: string; error: string; rows_done: number }>(db, 'SELECT state, error, rows_done FROM import_batch_jobs WHERE batch_id = $1', [b.id]);
    expect(job[0]).toMatchObject({ state: 'failed', rows_done: 25 });
    const st = await q<{ s: string }>(db, 'SELECT imp_status_of($1::uuid) AS s', [b.id]);
    expect(st[0]!.s).toBe('partially_approved');
    expect(await sitesOf(b.codes)).toHaveLength(25);
    expect(await auditCount('import_batch_processing_stopped', b.id)).toBe(1);
  }, 180_000);

  it('without any help, the API starts the run itself after the request and the batch ends by polling (as the web page does)', async () => {
    const b = await bigBatch(l1, ROWS);
    jobs.autoStart = true;
    try {
      const sent = await l1.api.call('post', `/import-batches/${b.id}/submit`, undefined, { 'If-Match': b.tag });
      expect(sent.status).toBe(202);
      let status = sent.body.status as string;
      for (let i = 0; i < 120 && status === 'processing'; i++) {
        await new Promise((r) => setTimeout(r, 250));
        status = (await l1.api.call('get', `/import-batches/${b.id}`)).body.status as string;
      }
      expect(status).toBe('in_approval');
    } finally {
      jobs.autoStart = false;
      await jobs.idle();
    }
  }, 120_000);

  it('a small batch (50 rows or fewer) is still sent in the request (200)', async () => {
    const b = await bigBatch(l1, 3);
    const sent = await l1.api.call('post', `/import-batches/${b.id}/submit`, undefined, { 'If-Match': b.tag });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ status: 'in_approval', progress: null, outcome: { submitted: 3 } });
  }, 60_000);
});
